const GHOST_API_URL = process.env.GHOST_API_URL;
const GHOST_ADMIN_KEY = process.env.GHOST_ADMIN_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// Import GA4
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

// Ghost JWT token generation
const jwt = require('jsonwebtoken');
const [id, secret] = GHOST_ADMIN_KEY.split(':');
const token = jwt.sign({}, Buffer.from(secret, 'hex'), {
  keyid: id,
  algorithm: 'HS256',
  expiresIn: '5m',
  audience: `/admin/`
});

async function getGhostPosts() {
  const response = await fetch(
    `${GHOST_API_URL}/ghost/api/admin/posts/?filter=status:published&include=tags&limit=all`,
    {
      headers: {
        Authorization: `Ghost ${token}`
      }
    }
  );
  const data = await response.json();
  
  if (!data.posts) {
    console.error('No posts array found. Response:', data);
    return [];
  }
  
  console.log(`Found ${data.posts.length} published posts from Ghost`);
  
  return data.posts;
}

async function getGA4PageViews(ghostPosts) {
  const analyticsDataClient = new BetaAnalyticsDataClient({
    credentials: GOOGLE_CREDENTIALS
  });

  // Extract all page paths from Ghost posts
  const pagePaths = ghostPosts.map(post => {
    // Convert full URL to just the path
    const url = new URL(post.url);
    return url.pathname;
  });

  try {
    const [response] = await analyticsDataClient.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      dateRanges: [
        {
          startDate: '2020-01-01', // Get all-time views
          endDate: 'today',
        },
      ],
      dimensions: [
        {
          name: 'pagePath',
        },
      ],
      metrics: [
        {
          name: 'screenPageViews',
        },
      ],
    });

    // Create a map of path -> views
    const viewsMap = {};
    response.rows?.forEach(row => {
      const path = row.dimensionValues[0].value;
      const views = parseInt(row.metricValues[0].value);
      viewsMap[path] = views;
    });

    console.log(`Retrieved view data for ${Object.keys(viewsMap).length} pages from GA4`);
    
    return viewsMap;
  } catch (error) {
    console.error('GA4 API Error:', error);
    return {};
  }
}

async function getNotionPages() {
  const response = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    }
  );
  const data = await response.json();
  return data.results;
}

async function createNotionPage(ghostPost, views = 0) {
  let tagNames = [];
  if (ghostPost.tags && Array.isArray(ghostPost.tags)) {
    tagNames = ghostPost.tags.map(tag => {
      return typeof tag === 'string' ? tag : tag.name;
    }).filter(name => name);
  }
  
  const response = await fetch(`https://api.notion.com/v1/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        'Post Title': {
          title: [{ text: { content: ghostPost.title } }]
        },
        'Slug': {
          rich_text: [{ text: { content: ghostPost.slug } }]
        },
        'Post URL': {
          url: ghostPost.url
        },
        'Published Date': {
          date: { start: ghostPost.published_at }
        },
        'Tags': {
          multi_select: tagNames.map(name => ({ name: name }))
        },
        'Featured': {
          checkbox: ghostPost.featured || false
        },
        'Views': {
          number: views
        },
        'Last Synced': {
          date: { start: new Date().toISOString() }
        }
      }
    })
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    console.error(`Failed to create page for ${ghostPost.title}:`, result);
    throw new Error(result.message);
  }
  
  console.log(`✓ Created: ${ghostPost.title} (${views} views)`);
}

async function updateNotionPage(pageId, ghostPost, views = null) {
  let tagNames = [];
  if (ghostPost.tags && Array.isArray(ghostPost.tags)) {
    tagNames = ghostPost.tags.map(tag => {
      return typeof tag === 'string' ? tag : tag.name;
    }).filter(name => name);
  }
  
  const properties = {
    'Post Title': {
      title: [{ text: { content: ghostPost.title } }]
    },
    'Slug': {
      rich_text: [{ text: { content: ghostPost.slug } }]
    },
    'Post URL': {
      url: ghostPost.url
    },
    'Published Date': {
      date: { start: ghostPost.published_at }
    },
    'Tags': {
      multi_select: tagNames.map(name => ({ name: name }))
    },
    'Featured': {
      checkbox: ghostPost.featured || false
    },
    'Last Synced': {
      date: { start: new Date().toISOString() }
    }
  };

  // Only update views if we have GA4 data
  if (views !== null) {
    properties['Views'] = { number: views };
  }
  
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });
  
  console.log(`✓ Updated: ${ghostPost.title}${views !== null ? ` (${views} views)` : ''}`);
}

async function syncAnalytics() {
  try {
    const ghostPosts = await getGhostPosts();
    const ga4Views = await getGA4PageViews(ghostPosts);
    const notionPages = await getNotionPages();
    
    for (const ghostPost of ghostPosts) {
      // Get views from GA4
      const url = new URL(ghostPost.url);
      const pagePath = url.pathname;
      const views = ga4Views[pagePath] || 0;
      
      // Find matching Notion page by slug
      const matchingPage = notionPages.find(page => {
        const slugProperty = page.properties['Slug'];
        if (slugProperty?.rich_text && slugProperty.rich_text.length > 0) {
          return slugProperty.rich_text[0].text.content === ghostPost.slug;
        }
        return false;
      });
      
      if (matchingPage) {
        await updateNotionPage(matchingPage.id, ghostPost, views);
      } else {
        await createNotionPage(ghostPost, views);
      }
    }
    
    console.log('✨ Sync complete!');
  } catch (error) {
    console.error('Sync failed:', error);
    throw error;
  }
}

syncAnalytics();
