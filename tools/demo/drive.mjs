#!/usr/bin/env node
/**
 * Drive the Blackbox demo in a real, visible Chrome, so a screen recorder can
 * capture it.
 *
 * The point is that the camera work is deterministic and the narration is not:
 * every beat waits for Enter, so the presenter talks for as long as they like
 * and the page moves on cue rather than on a timer. A missed word costs a
 * pause, not a retake.
 *
 * Zero dependencies. It speaks the DevTools Protocol over the WebSocket that
 * Node has had built in since 22, so there is nothing to install and nothing
 * to keep in step with a browser version.
 *
 *   node tools/demo/drive.mjs                      # against the deployment
 *   node tools/demo/drive.mjs --url http://localhost:4173
 *   node tools/demo/drive.mjs --from 6             # resume at beat 6
 *   node tools/demo/drive.mjs --auto 6000          # advance on a timer instead
 *
 * Press Enter to advance, `q` then Enter to stop. Chrome is left open.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const BASE = (flag('url', 'https://blackbox-kh.parakramlabs.com') ?? '').replace(/\/$/, '');
const FROM = Number(flag('from', '1'));
/** Stop after this beat. Used to rehearse without reaching the demo press. */
const TO = Number(flag('to', String(Number.MAX_SAFE_INTEGER)));
/**
 * Rehearse without a display. Every selector and every navigation is exercised;
 * only the recording is missing. There is no point handing someone a driver
 * whose choreography has never been run.
 */
const HEADLESS = args.includes('--headless');
const AUTO = args.includes('--auto') ? Number(flag('auto', '6000')) : null;
const PORT = Number(flag('port', '9222'));

/** 1440x900 is the recording size: legible on a projector, 16:10, no scaling. */
const WIDTH = 1440;
const HEIGHT = 900;

const CHROME =
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) =>
    existsSync(p),
  ) ?? 'google-chrome';

// ---------------------------------------------------------------- the browser

function launch() {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      ...(HEADLESS ? ['--headless=new'] : []),
      `--window-size=${WIDTH},${HEIGHT}`,
      '--window-position=0,0',
      // A clean profile: no bookmarks bar, no restored tabs, no extensions in
      // the corner of the frame, and no session left over from a rehearsal.
      `--user-data-dir=/tmp/blackbox-demo-profile`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--hide-crash-restore-bubble',
      BASE,
    ],
    { stdio: 'ignore', detached: false },
  );
  return child;
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function attach() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await targets();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Chrome never opened a debuggable page on ${PORT}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  #ws;
  #id = 0;
  #pending = new Map();
  /** One-shot waiters for CDP events, keyed by method name. */
  #events = new Map();

  static async open(url) {
    const session = new Session();
    session.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener('open', resolve, { once: true });
      session.#ws.addEventListener('error', reject, { once: true });
    });
    session.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) {
        const waiters = session.#events.get(msg.method);
        if (waiters) {
          session.#events.delete(msg.method);
          for (const resolve of waiters) resolve(msg.params);
        }
        return;
      }
      const waiter = session.#pending.get(msg.id);
      if (!waiter) return;
      session.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    return session;
  }

  send(method, params = {}) {
    const id = (this.#id += 1);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve the next time Chrome emits this event, or after `ms`. */
  once(method, ms = 15000) {
    return new Promise((resolve) => {
      const waiters = this.#events.get(method) ?? [];
      waiters.push(resolve);
      this.#events.set(method, waiters);
      setTimeout(() => resolve(null), ms);
    });
  }

  /**
   * Evaluate in the page and return the value.
   *
   * Retried once on a destroyed context: a navigation tears the context down,
   * and an evaluate that was already in flight loses rather than fails.
   */
  async eval(expression, retry = true) {
    let result;
    try {
      result = await this.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
    } catch (error) {
      if (retry && /context was destroyed|Cannot find context/i.test(String(error.message))) {
        await sleep(300);
        return this.eval(expression, false);
      }
      throw error;
    }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'page threw');
    }
    return result.result?.value;
  }

  async go(path) {
    // The load event is awaited before anything is evaluated, because a
    // navigation destroys the context an evaluate would have run in.
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url: `${BASE}${path}` });
    await loaded;
    await this.settle();
  }

  /** Wait for the document to be ready and one frame to have painted. */
  async settle() {
    for (let i = 0; i < 80; i += 1) {
      const ready = await this.eval(`return document.readyState === 'complete'`).catch(() => false);
      if (ready) break;
      await sleep(100);
    }
    await this.eval(`return new Promise(r => requestAnimationFrame(() => r(true)))`).catch(
      () => undefined,
    );
  }
}

// ------------------------------------------------------------------ behaviour

/**
 * Scroll the way a person does, not the way a script does.
 *
 * An instant jump gives an editor no frame to cut on and reads as a slide
 * transition; smooth scrolling to a named element lands the thing being
 * discussed in the same place every take.
 */
const scrollTo = (selector, block = 'start') => `
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
  el.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(block)} });
  await new Promise(r => setTimeout(r, 900));
  return true;
`;

const clickText = (selector, text) => `
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => e.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (!el) throw new Error('no ' + ${JSON.stringify(selector)} + ' saying ' + ${JSON.stringify(text)});
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(r => setTimeout(r, 700));
  el.click();
  return true;
`;

/**
 * Wait for the incident the demo induced to appear on its own.
 *
 * This is the beat the whole recording exists for, so it is watched rather
 * than slept through: the moment it lands, the take can move on, and if it
 * never lands the script says so instead of cutting to an empty panel.
 */
const waitForNewIncident = (before) => `
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const res = await fetch('/api/stats');
    const s = await res.json();
    if (s.incidentsDetected > ${before}) return Math.round((Date.now() - started) / 1000);
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
`;

// ---------------------------------------------------------------------- beats

/**
 * Each beat is one thing to say and one thing to show. `say` is the cue, not
 * the narration — the full script lives beside this file.
 */
const BEATS = [
  {
    say: 'Front page. The claim, and one real incident beside it.',
    async run(s) {
      await s.go('/');
      await s.eval(`window.scrollTo({ top: 0 }); return true`);
    },
  },
  {
    say: 'The specimen: the measured value beside the threshold it was judged against.',
    run: (s) => s.eval(scrollTo('.specimen', 'center')),
  },
  {
    say: 'Three numbers. Detected, fixed onchain, and how long noticing takes.',
    run: (s) => s.eval(scrollTo('.numbers', 'center')),
  },
  {
    say: 'One incident end to end, with the real elapsed times.',
    run: (s) => s.eval(scrollTo('.arc', 'center')),
  },
  {
    say: 'The ten failures it recognises. If yours is not here, it will not be found.',
    run: (s) => s.eval(scrollTo('.taxonomy', 'start')),
  },
  {
    say: 'Receipts. Every one is a real transaction on a public chain.',
    run: (s) => s.eval(scrollTo('.landing__proof', 'start')),
  },
  {
    say: 'Into the console.',
    async run(s) {
      await s.go('/dashboard');
      await s.eval(`window.scrollTo({ top: 0 }); return true`);
    },
  },
  {
    say: 'The record is chained: nothing edited, nothing removed.',
    run: (s) =>
      s
        .eval(scrollTo('.dash__ledger', 'center'))
        .catch(() => 'no chained entries yet — skip this line'),
  },
  {
    say: 'The stream itself, including everything that never becomes an incident.',
    run: (s) => s.eval(scrollTo('.dash__log', 'center')),
  },
  {
    say: 'Now break something. Three refused runs, no gas.',
    async run(s) {
      const state = await s.eval(`const r = await fetch('/api/demo'); return r.json()`);
      if (!state.ready) {
        return `NOT READY — cooldown until ${state.nextAllowedAt}. Do not press.`;
      }
      const before = await s.eval(`const r = await fetch('/api/stats'); return (await r.json()).incidentsDetected`);
      await s.eval(clickText('button', 'break'));
      return `pressed — was ${before} incidents`;
    },
  },
  {
    say: 'Say nothing. Watch the log. It arrives without a reload.',
    async run(s) {
      const before = await s.eval(
        `const r = await fetch('/api/stats'); return (await r.json()).incidentsDetected - 1`,
      );
      await s.eval(scrollTo('.dash__log', 'center'));
      const seconds = await s.eval(waitForNewIncident(before));
      return seconds === null ? 'nothing arrived in 90s' : `arrived after ~${seconds}s`;
    },
  },
  {
    say: 'Open it. Evidence first.',
    async run(s) {
      // Self-sufficient, so --from can resume here without the earlier beats
      // having navigated for it.
      const here = await s.eval(`return location.pathname`);
      if (here !== '/dashboard') await s.go('/dashboard');
      await s.eval(scrollTo('.dash__now', 'start'));
      await s.eval(clickText('.dash__link', ''));
      await s.settle();
    },
  },
  {
    say: 'The numbers it was judged on, each beside its threshold.',
    run: (s) => s.eval(scrollTo('.facts', 'center')).catch(() => s.eval(scrollTo('.panel', 'center'))),
  },
  {
    say: 'The steps behind the run. Which one failed, and what it said.',
    run: (s) =>
      s
        .eval(scrollTo('.runlog', 'center'))
        .catch(() => 'run log hidden — only the owning organisation sees it. Sign in first, or cut this beat.'),
  },
  {
    say: 'And the fix, with a hash anyone can look up.',
    run: (s) =>
      s.eval(scrollTo('.remediation', 'center')).catch(() => 'no remediation on this incident'),
  },
];

// ------------------------------------------------------------------------ run

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const chrome = launch();
process.on('exit', () => chrome.kill());

console.log(`\n  Blackbox demo driver — ${BASE}`);
console.log(`  Window ${WIDTH}x${HEIGHT}. Point OBS at it, then advance with Enter.\n`);

const session = await Session.open(await attach());
await session.settle();

for (const [index, beat] of BEATS.entries()) {
  const number = index + 1;
  if (number < FROM) continue;
  if (number > TO) break;

  console.log(`  ${String(number).padStart(2, '0')}. ${beat.say}`);
  let note;
  try {
    note = await beat.run(session);
  } catch (error) {
    note = `FAILED: ${error.message}`;
  }
  if (typeof note === 'string' && note !== 'true') console.log(`      → ${note}`);

  if (AUTO) await sleep(AUTO);
  else {
    const answer = await ask('      [Enter] ');
    if (answer.trim().toLowerCase() === 'q') break;
  }
}

console.log('\n  Done. Chrome is still open; close it when the recording stops.\n');
rl.close();
