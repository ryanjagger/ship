import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '../../e2e/fixtures/isolated-env';

type RouteAudit = {
  name: string;
  path: string;
  authenticated: boolean;
  importance: 'primary' | 'major';
};

type AxeViolation = {
  id: string;
  impact: string;
  description: string;
  help: string;
  nodes: Array<{ target: string[]; html: string; failureSummary?: string }>;
};

type KeyboardResult = {
  route: string;
  focusableCount: number;
  reachedCount: number;
  completeness: 'Full' | 'Partial' | 'Broken';
  missed: string[];
  order: string[];
};

type ScreenReaderResult = {
  route: string;
  h1Count: number;
  mainCount: number;
  navCount: number;
  unnamedButtons: number;
  unnamedLinks: number;
  unnamedInputs: number;
  status: 'Pass' | 'Needs review' | 'Fail';
  notes: string[];
};

const routes: RouteAudit[] = [
  { name: 'Login', path: '/login', authenticated: false, importance: 'major' },
  { name: 'My Week', path: '/my-week', authenticated: true, importance: 'primary' },
  { name: 'Docs', path: '/docs', authenticated: true, importance: 'primary' },
  { name: 'Issues', path: '/issues', authenticated: true, importance: 'primary' },
  { name: 'Programs', path: '/programs', authenticated: true, importance: 'major' },
  { name: 'Projects', path: '/projects', authenticated: true, importance: 'major' },
  { name: 'Team Allocation', path: '/team/allocation', authenticated: true, importance: 'major' },
  { name: 'Team Directory', path: '/team/directory', authenticated: true, importance: 'major' },
  { name: 'Team Status', path: '/team/status', authenticated: true, importance: 'major' },
  { name: 'Settings', path: '/settings', authenticated: true, importance: 'major' },
];

const auditDir = path.resolve(__dirname);
const resultsPath = path.join(auditDir, 'results.json');
const lighthouseRoot = process.env.LIGHTHOUSE_NODE_MODULES || '/private/tmp/ship-a11y-tools/node_modules';

async function login(page: import('@playwright/test').Page, baseURL: string) {
  await page.goto(`${baseURL}/login`);
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
}

async function prepareRoute(page: import('@playwright/test').Page, baseURL: string, route: RouteAudit) {
  await page.goto(`${baseURL}${route.path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
}

async function runKeyboardCheck(page: import('@playwright/test').Page, route: RouteAudit): Promise<KeyboardResult> {
  const before = await page.evaluate(() => {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="combobox"]',
      '[role="option"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const isVisible = (el: Element) => {
      const element = el as HTMLElement;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        !element.hasAttribute('disabled') &&
        element.getAttribute('aria-hidden') !== 'true' &&
        element.tabIndex >= 0;
    };

    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map((el, index) => {
        const element = el as HTMLElement;
        element.dataset.auditFocusId = `focus-${index}`;
        const label = element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          element.textContent?.replace(/\s+/g, ' ').trim() ||
          element.getAttribute('placeholder') ||
          element.getAttribute('href') ||
          element.tagName.toLowerCase();
        return {
          id: element.dataset.auditFocusId,
          label: `${element.tagName.toLowerCase()} ${label || ''}`.trim().slice(0, 80),
        };
      });
  });

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  const visited = new Set<string>();
  const order: string[] = [];
  const maxTabs = Math.min(Math.max(before.length + 12, 12), 260);
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const current = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      return {
        id: el.dataset.auditFocusId || null,
        label: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') || el.textContent?.replace(/\s+/g, ' ').trim() || el.getAttribute('placeholder') || ''}`.trim().slice(0, 80),
      };
    });
    if (current?.id && !visited.has(current.id)) {
      visited.add(current.id);
      order.push(current.label);
    }
  }

  const missed = before.filter(item => !visited.has(item.id)).map(item => item.label);
  const reachedRatio = before.length === 0 ? 1 : visited.size / before.length;
  const completeness = reachedRatio >= 0.95 ? 'Full' : reachedRatio >= 0.5 ? 'Partial' : 'Broken';

  return {
    route: route.name,
    focusableCount: before.length,
    reachedCount: visited.size,
    completeness,
    missed,
    order,
  };
}

async function runScreenReaderProxy(page: import('@playwright/test').Page, route: RouteAudit): Promise<ScreenReaderResult> {
  const result = await page.evaluate(() => {
    const text = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const hasName = (el: Element) => Boolean(
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') ||
      el.getAttribute('title') ||
      text(el) ||
      (el instanceof HTMLInputElement && (el.placeholder || el.labels?.length))
    );

    return {
      h1Count: document.querySelectorAll('h1').length,
      mainCount: document.querySelectorAll('main, [role="main"]').length,
      navCount: document.querySelectorAll('nav, [role="navigation"]').length,
      unnamedButtons: Array.from(document.querySelectorAll('button, [role="button"]')).filter(el => !hasName(el)).length,
      unnamedLinks: Array.from(document.querySelectorAll('a[href], [role="link"]')).filter(el => !hasName(el)).length,
      unnamedInputs: Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]')).filter(el => !hasName(el)).length,
    };
  });

  const notes: string[] = [];
  if (result.h1Count !== 1) notes.push(`Expected exactly one h1, found ${result.h1Count}.`);
  if (route.authenticated && result.mainCount < 1) notes.push('Missing main landmark.');
  if (route.authenticated && result.navCount < 1) notes.push('Missing navigation landmark.');
  if (result.unnamedButtons > 0) notes.push(`${result.unnamedButtons} button(s) lack accessible names.`);
  if (result.unnamedLinks > 0) notes.push(`${result.unnamedLinks} link(s) lack accessible names.`);
  if (result.unnamedInputs > 0) notes.push(`${result.unnamedInputs} form control(s) lack accessible names.`);

  return {
    route: route.name,
    ...result,
    status: notes.length === 0 ? 'Pass' : result.unnamedButtons || result.unnamedLinks || result.unnamedInputs ? 'Fail' : 'Needs review',
    notes,
  };
}

test('full accessibility audit', async ({ page, baseURL }) => {
  test.setTimeout(240000);
  mkdirSync(auditDir, { recursive: true });

  await page.context().addInitScript(() => {
    localStorage.setItem('ship:disableActionItemsModal', 'true');
  });

  const axeResults: Record<string, { violations: AxeViolation[]; countsByImpact: Record<string, number> }> = {};
  const keyboardResults: KeyboardResult[] = [];
  const screenReaderResults: ScreenReaderResult[] = [];

  const publicRoutes = routes.filter(route => !route.authenticated);
  const authenticatedRoutes = routes.filter(route => route.authenticated);

  for (const route of publicRoutes) {
    await prepareRoute(page, baseURL!, route);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    axeResults[route.name] = {
      countsByImpact: axe.violations.reduce<Record<string, number>>((acc, violation) => {
        const impact = violation.impact || 'unknown';
        acc[impact] = (acc[impact] || 0) + 1;
        return acc;
      }, {}),
      violations: axe.violations.map(violation => ({
        id: violation.id,
        impact: violation.impact || 'unknown',
        description: violation.description,
        help: violation.help,
        nodes: violation.nodes.map(node => ({
          target: node.target,
          html: node.html,
          failureSummary: node.failureSummary,
        })),
      })),
    };

    keyboardResults.push(await runKeyboardCheck(page, route));
    screenReaderResults.push(await runScreenReaderProxy(page, route));
  }

  await login(page, baseURL!);

  for (const route of authenticatedRoutes) {
    await prepareRoute(page, baseURL!, route);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    axeResults[route.name] = {
      countsByImpact: axe.violations.reduce<Record<string, number>>((acc, violation) => {
        const impact = violation.impact || 'unknown';
        acc[impact] = (acc[impact] || 0) + 1;
        return acc;
      }, {}),
      violations: axe.violations.map(violation => ({
        id: violation.id,
        impact: violation.impact || 'unknown',
        description: violation.description,
        help: violation.help,
        nodes: violation.nodes.map(node => ({
          target: node.target,
          html: node.html,
          failureSummary: node.failureSummary,
        })),
      })),
    };

    keyboardResults.push(await runKeyboardCheck(page, route));
    screenReaderResults.push(await runScreenReaderProxy(page, route));
  }

  const [{ default: lighthouse }, chromeLauncher] = await Promise.all([
    import(`${lighthouseRoot}/lighthouse/core/index.js`),
    import(`${lighthouseRoot}/chrome-launcher/dist/index.js`),
  ]);

  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });

  const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
  try {
    const context = cdpBrowser.contexts()[0] || await cdpBrowser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('ship:disableActionItemsModal', 'true');
    });
    const lhPage = context.pages()[0] || await context.newPage();

    const lighthouseResults: Record<string, { score: number; failingAudits: Array<{ id: string; title: string; scoreDisplayMode: string; description?: string; details?: unknown }> }> = {};
    for (const route of publicRoutes) {
      await lhPage.goto(`${baseURL}${route.path}`, { waitUntil: 'domcontentloaded' });
      await lhPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      const result = await lighthouse(`${baseURL}${route.path}`, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['accessibility'],
      }, {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['accessibility'],
          disableStorageReset: true,
          formFactor: 'desktop',
          screenEmulation: {
            mobile: false,
            width: 1440,
            height: 1000,
            deviceScaleFactor: 1,
            disabled: false,
          },
        },
      });

      const lhr = result.lhr;
      lighthouseResults[route.name] = {
        score: Math.round((lhr.categories.accessibility.score ?? 0) * 100),
        failingAudits: Object.values(lhr.audits)
          .filter((audit: any) => audit.score !== null && audit.score !== 1 && audit.scoreDisplayMode !== 'notApplicable')
          .map((audit: any) => ({
            id: audit.id,
            title: audit.title,
            scoreDisplayMode: audit.scoreDisplayMode,
            description: audit.description,
            details: audit.details,
          })),
      };
    }

    await login(lhPage, baseURL!);

    for (const route of authenticatedRoutes) {
      await lhPage.goto(`${baseURL}${route.path}`, { waitUntil: 'domcontentloaded' });
      await lhPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      const result = await lighthouse(`${baseURL}${route.path}`, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['accessibility'],
      }, {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['accessibility'],
          disableStorageReset: true,
          formFactor: 'desktop',
          screenEmulation: {
            mobile: false,
            width: 1440,
            height: 1000,
            deviceScaleFactor: 1,
            disabled: false,
          },
        },
      });

      const lhr = result.lhr;
      lighthouseResults[route.name] = {
        score: Math.round((lhr.categories.accessibility.score ?? 0) * 100),
        failingAudits: Object.values(lhr.audits)
          .filter((audit: any) => audit.score !== null && audit.score !== 1 && audit.scoreDisplayMode !== 'notApplicable')
          .map((audit: any) => ({
            id: audit.id,
            title: audit.title,
            scoreDisplayMode: audit.scoreDisplayMode,
            description: audit.description,
            details: audit.details,
          })),
      };
    }

    writeFileSync(resultsPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      routes,
      lighthouse: lighthouseResults,
      axe: axeResults,
      keyboard: keyboardResults,
      screenReaderProxy: screenReaderResults,
    }, null, 2));
  } finally {
    await cdpBrowser.close().catch(() => undefined);
    await chrome.kill();
  }
});
