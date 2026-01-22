const GHOST_API_URL = process.env.GHOST_API_URL;
const GHOST_ADMIN_KEY = process.env.GHOST_ADMIN_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

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
    `${GHOST_API_URL}/ghost/api/admin/posts/?filter=status:published&include=id,title,slug,url,published_at,featured,tags&limit=all`,
    {
      headers: {
        Authorization: `Ghost ${token}`
      }
    }
  );
  const data = await response.json();
  
  // Debug: see what Ghost returns
  console.log(`Found ${data.posts.length} published posts from Ghost`);
  
  return data.posts;
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

async function createNotionPage(ghostPost) {
  const tagNames = ghostPost.tags ? ghostPost.tags.map(tag => tag.name) : [];
  
  await fetch(`https://api.notion.com/v1/pages`, {
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
          multi_select: tagNames.map(name => ({ name }))
        },
        'Featured': {
          checkbox: ghostPost.featured || false
        },
        'Views': {
          number: 0  // Will be updated later with GA4
        },
        'Last Synced': {
          date: { start: new Date().toISOString() }
        }
      }
    })
  });
  
  console.log(`Created new page for: ${ghostPost.title}`);
}

async function updateNotionPage(pageId, ghostPost) {
  const tagNames = ghostPost.tags ? ghostPost.tags.map(tag => tag.name) : [];
  
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
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
          multi_select: tagNames.map(name => ({ name }))
        },
        'Featured': {
          checkbox: ghostPost.featured || false
        },
        'Last Synced': {
          date: { start: new Date().toISOString() }
        }
      }
    })
  });
  
  console.log(`Updated: ${ghostPost.title}`);
}

async function syncAnalytics() {
  try {
    const ghostPosts = await getGhostPosts();
    const notionPages = await getNotionPages();
    
    for (const ghostPost of ghostPosts) {
      // Find matching Notion page by slug
      const matchingPage = notionPages.find(page => {
        const slugProperty = page.properties['Slug'];
        if (slugProperty?.rich_text && slugProperty.rich_text.length > 0) {
          return slugProperty.rich_text[0].text.content === ghostPost.slug;
        }
        return false;
      });
      
      if (matchingPage) {
        // Update existing page
        await updateNotionPage(matchingPage.id, ghostPost);
      } else {
        // Create new page
        await createNotionPage(ghostPost);
      }
    }
    
    console.log('Sync complete!');
  } catch (error) {
    console.error('Sync failed:', error);
    throw error;
  }
}

syncAnalytics();
