/**
 * Browser Service for handling Puppeteer browser operations (robust)
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import randomUserAgent from 'user-agents';
import { CONFIG } from '../config/config.js';
import { getRandomViewport, sleep } from '../utils/helpers.js';

puppeteer.use(StealthPlugin());

export class BrowserService {
  /**
   * Initialize and configure browser
   * @returns {Promise<{browser: import('puppeteer').Browser, page: import('puppeteer').Page}>}
   */
  static async initializeBrowser() {
    const browser = await puppeteer.launch({
      headless: CONFIG.BROWSER.HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();

    await page.setUserAgent(new randomUserAgent().toString());
    await page.setViewport(getRandomViewport());

    // Sedikit lebih stabil untuk SPA
    page.setDefaultNavigationTimeout(CONFIG.TIMING.NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(CONFIG.TIMING.SELECTOR_TIMEOUT);

    return { browser, page };
  }

  /**
   * Navigate to URL with error handling
   */
  static async navigateToURL(page, url, errorMessage) {
    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: CONFIG.TIMING.NAVIGATION_TIMEOUT,
      });
    } catch (error) {
      console.error(errorMessage);
      throw error;
    }
  }

  // -----------------------------
  // Core robust helpers
  // -----------------------------

  /**
   * Find first matching selector in page OR any frame.
   * @param {import('puppeteer').Page} page
   * @param {string|string[]} selectors - single selector or list of candidate selectors
   * @param {number} timeout
   * @returns {Promise<{ ctx: import('puppeteer').Page | import('puppeteer').Frame, selector: string }>}
   */
  static async findInPageOrFrames(page, selectors, timeout = CONFIG.TIMING.SELECTOR_TIMEOUT) {
    const sels = Array.isArray(selectors) ? selectors : [selectors];
    const start = Date.now();

    const exists = async (ctx, sel) => {
      try {
        return (await ctx.$(sel)) !== null;
      } catch {
        return false;
      }
    };

    while (Date.now() - start < timeout) {
      // Main page first
      for (const sel of sels) {
        if (await exists(page, sel)) return { ctx: page, selector: sel };
      }

      // Then frames
      for (const fr of page.frames()) {
        for (const sel of sels) {
          if (await exists(fr, sel)) return { ctx: fr, selector: sel };
        }
      }

      await page.waitForTimeout(250);
    }

    throw new Error(`Selector tidak ditemukan (page/frames): ${sels.join(' | ')}`);
  }

  /**
   * Wait for element to be visible-ish and have size.
   * Works with Page or Frame context.
   */
  static async waitForVisible(ctx, selector, timeout = CONFIG.TIMING.SELECTOR_TIMEOUT) {
    // waitForSelector visible kadang lolos tapi masih 0x0 atau tertutup
    await ctx.waitForSelector(selector, { visible: true, timeout });

    await ctx.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          st.display !== 'none' &&
          st.visibility !== 'hidden' &&
          st.opacity !== '0'
        );
      },
      { timeout },
      selector
    );
  }

  /**
   * Scroll element into view.
   */
  static async scrollIntoViewIfNeeded(ctx, selector) {
    try {
      await ctx.evaluate((sel) => {
        const el = document.querySelector(sel);
        el?.scrollIntoView({ block: 'center', inline: 'center' });
      }, selector);
    } catch (_) {}
  }

  /**
   * Click element with retries + scroll.
   * selector can be string or list of candidates.
   */
  static async clickElement(page, selectorOrCandidates, opts = {}) {
    const timeout = opts.timeout ?? CONFIG.TIMING.SELECTOR_TIMEOUT;
    const retries = opts.retries ?? 2;
    const delay = opts.delay ?? 80;

    let lastErr = null;

    for (let i = 0; i <= retries; i++) {
      try {
        const { ctx, selector } = await this.findInPageOrFrames(page, selectorOrCandidates, timeout);
        await this.waitForVisible(ctx, selector, timeout);
        await this.scrollIntoViewIfNeeded(ctx, selector);
        await ctx.click(selector, { delay });
        return;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(400);
      }
    }

    throw lastErr;
  }

  /**
   * Type text into input field with retries + clear + scroll.
   * selector can be string or list of candidates.
   */
  static async typeIntoField(page, selectorOrCandidates, text, opts = {}) {
    const timeout = opts.timeout ?? CONFIG.TIMING.SELECTOR_TIMEOUT;
    const retries = opts.retries ?? 2;
    const delay = opts.delay ?? CONFIG.TIMING.TYPING_DELAY;

    let lastErr = null;

    for (let i = 0; i <= retries; i++) {
      try {
        const { ctx, selector } = await this.findInPageOrFrames(page, selectorOrCandidates, timeout);
        await this.waitForVisible(ctx, selector, timeout);
        await this.scrollIntoViewIfNeeded(ctx, selector);

        // focus + clear
        await ctx.click(selector, { clickCount: 3, delay: 50 }).catch(() => {});
        // backspace via keyboard hanya tersedia di Page, tapi Frame juga punya keyboard via page
        // jadi aman gunakan page.keyboard
        await page.keyboard.press('Backspace').catch(() => {});

        await ctx.type(selector, text, { delay });
        return;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(400);
      }
    }

    throw lastErr;
  }

  /**
   * Select dropdown item by text (generic)
   * - Works for lists like .lv-select-popup li or [role="option"]
   */
  static async selectDropdownItem(page, itemText, opts = {}) {
    const timeout = opts.timeout ?? CONFIG.TIMING.SELECTOR_TIMEOUT;

    // Candidate list item selectors (bisa kamu tambah kalau UI berubah)
    const itemCandidates = [
      CONFIG.CAPCUT?.SELECTORS?.DROPDOWN_ITEMS,
      '.lv-select-popup li',
      '[role="option"]',
      'li[role="option"]',
      '[data-value]',
    ].filter(Boolean);

    const { ctx, selector: itemSel } = await this.findInPageOrFrames(page, itemCandidates, timeout);
    await ctx.waitForSelector(itemSel, { visible: true, timeout });

    const wanted = String(itemText).trim().toLowerCase();

    const clicked = await ctx.evaluate((sel, w) => {
      const els = [...document.querySelectorAll(sel)];
      const target =
        els.find((e) => (e.textContent || '').trim().toLowerCase() === w) ||
        els.find((e) => (e.textContent || '').trim().toLowerCase().includes(w)) ||
        els.find((e) => (e.getAttribute('data-value') || '').trim().toLowerCase() === w);

      if (target && typeof target.click === 'function') {
        target.click();
        return true;
      }
      return false;
    }, itemSel, wanted);

    if (!clicked) throw new Error(`Dropdown item tidak ditemukan: "${itemText}"`);
  }

  /**
   * Debug helper (optional): dump basic info
   */
  static async debugSnapshot(page, name = 'debug') {
    await page.screenshot({ path: `${name}.png`, fullPage: true }).catch(() => {});
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '');
    console.log(`DEBUG(${name}) visible text:\n`, text);
  }

  /**
   * Close browser instance
   */
  static async closeBrowser(browser) {
    if (browser) {
      await browser.close();
    }
  }
}
