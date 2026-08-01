require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Import scrapers safely
let scraper, enhancedScraper;

try {
  scraper = require('./scraper');
  console.log('✅ Basic scraper loaded');
} catch (error) {
  console.log('❌ Basic scraper failed:', error.message);
  scraper = null;
}

try {
  enhancedScraper = require('./enhanced-scraper');
  console.log('✅ Enhanced scraper loaded');
} catch (error) {
  console.log('❌ Enhanced scraper failed:', error.message);
  enhancedScraper = null;
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Basic scraping endpoint
app.post('/api/scrape', async (req, res) => {
  try {
    const { url, method, options = {} } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!scraper) {
      return res.status(500).json({ error: 'Scraper not available' });
    }

    let data;
    
    if (method === 'puppeteer' || options.dynamic) {
      data = await scraper.scrapeWithPuppeteer(url, options);
    } else {
      data = await scraper.scrapeWithCheerio(url, options);
    }

    res.json({
      success: true,
      data: data,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Enhanced scraping endpoint
app.post('/api/scrape-protected', async (req, res) => {
  try {
    const { url, options = {} } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!enhancedScraper) {
      return res.status(500).json({ error: 'Enhanced scraper not available' });
    }

    console.log(`🛡️ Attempting to scrape protected site: ${url}`);
    const data = await enhancedScraper.scrapeProtectedSite(url, options);
    
    res.json({
      success: true,
      data: data,
      method: 'enhanced',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Enhanced scraping error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test endpoint
app.post('/api/test-scraper', async (req, res) => {
  try {
    const testUrls = [
      'https://httpbin.org/html',
      'https://example.com'
    ];

    const results = [];
    
    for (const url of testUrls) {
      try {
        const data = await scraper.scrapeWithCheerio(url);
        results.push({
          url,
          status: 'success',
          title: data.title
        });
      } catch (error) {
        results.push({
          url,
          status: 'failed',
          error: error.message
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.json({
      success: true,
      results: results
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    scrapers: {
      basic: !!scraper,
      enhanced: !!enhancedScraper
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Web Scraper Server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoints available`);
});