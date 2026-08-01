const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');

class WebScraper {
  constructor() {
    this.proxies = [];
    try {
      this.proxies = require('./proxies.json');
    } catch (error) {
      console.log('⚠️ No proxies.json file found');
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async scrapeWithPuppeteer(url, options = {}) {
    let browser;
    try {
      const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      };

      browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();
      
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await this.delay(1000);

      console.log(`🌐 Navigating to: ${url}`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10000 });
      }

      await this.delay(options.delayMs || 2000);

      const data = await page.evaluate(() => {
        return {
          title: document.title,
          url: window.location.href,
          headings: {
            h1: Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim()),
            h2: Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim()),
            h3: Array.from(document.querySelectorAll('h3')).map(h => h.textContent.trim())
          },
          content: {
            text: document.body.innerText.substring(0, 1000) + '...'
          }
        };
      });

      return data;

    } catch (error) {
      throw new Error(`Puppeteer scraping failed: ${error.message}`);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async scrapeWithCheerio(url, options = {}) {
    try {
      const config = {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };

      await this.delay(1000);

      console.log(`📡 Fetching: ${url}`);
      const response = await axios.get(url, config);
      const $ = cheerio.load(response.data);

      const data = {
        title: $('title').text(),
        url: url,
        headings: {
          h1: $('h1').map((i, el) => $(el).text().trim()).get(),
          h2: $('h2').map((i, el) => $(el).text().trim()).get(),
          h3: $('h3').map((i, el) => $(el).text().trim()).get()
        },
        links: $('a[href]').map((i, el) => ({
          href: $(el).attr('href'),
          text: $(el).text().trim()
        })).get(),
        content: {
          text: $('body').text().replace(/\s+/g, ' ').substring(0, 1000) + '...'
        }
      };

      return data;

    } catch (error) {
      throw new Error(`Cheerio scraping failed: ${error.message}`);
    }
  }
}

module.exports = new WebScraper();