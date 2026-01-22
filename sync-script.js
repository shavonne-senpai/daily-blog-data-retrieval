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
    `${GHOST_API_URL}/ghost/api/admin/posts/?fields=id,title,slug,count.clicks,count.views&limit=all`,
    {
      headers: {
        Authorization: `Ghost ${token}`
      }
    }
  );
  const data = await response.json();
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

async function updateNotionPage(pageId, views) {
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        'Views': { number: views },
        'Last Updated': { date: { start: new Date().toISOString() } }
      }
    })
  });
}

async function syncAnalytics() {
  const ghostPosts = await getGhostPosts();
  const notionPages = await getNotionPages();
  
  for (const ghostPost of ghostPosts) {
    const matchingPage = notionPages.find(page => 
      page.properties['Post URL']?.rich_text[0]?.text.content.includes(ghostPost.slug)
    );
    
    if (matchingPage) {
      const views = ghostPost.count?.views || 0;
      await updateNotionPage(matchingPage.id, views);
      console.log(`Updated ${ghostPost.title}: ${views} views`);
    }
  }
}

syncAnalytics().catch(console.error);
