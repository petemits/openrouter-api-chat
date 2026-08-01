const puppeteer = require('puppeteer');

class EnhancedScraper {
  async scrapeProtectedSite(url, options = {}) {
    console.log(`🛡️ Starting enhanced scrape for: ${url}`);

    // Try enhanced method first
    try {
      const data = await this.stealthScrape(url, options);
      return data;
    } catch (error) {
      console.log('❌ Enhanced method failed:', error.message);
    }

    // Fallback to basic method
    try {
      const basicScraper = require('./scraper');
      const data = await basicScraper.scrapeWithPuppeteer(url, options);
      return data;
    } catch (error) {
      console.log('❌ Basic method failed:', error.message);
    }

    throw new Error('All scraping methods failed');
  }

  async stealthScrape(url, options) {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security'
      ]
    });

    try {
      const page = await browser.newPage();
      
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });

      console.log(`🌐 Navigating to protected site: ${url}`);
      
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      // Check if blocked
      const pageTitle = await page.title();
      if (pageTitle.includes('403') || pageTitle.includes('Forbidden')) {
        throw new Error('Website returned 403 Forbidden');
      }

      await this.delay(3000);

      const data = await page.evaluate(() => {
        return {
          title: document.title,
          url: window.location.href,
          content: document.body.innerText.substring(0, 2000) + '...',
          headings: {
            h1: Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim()),
            h2: Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim()),
            h3: Array.from(document.querySelectorAll('h3')).map(h => h.textContent.trim())
          },
          success: true
        };
      });

      console.log('✅ Successfully scraped protected site');
      return data;

    } catch (error) {
      console.error('❌ Stealth scraping failed:', error.message);
      throw error;
    } finally {
      await browser.close();
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new EnhancedScraper();