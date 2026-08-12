import { Link } from '@tanstack/react-router';
import { useConsole } from '../../lib/store';
import type { AppConfig } from '../../lib/types';
import './landing.css';

/**
 * The front page.
 *
 * It carries none of the console's instruments: an incident queue, a chain list
 * and a stream indicator are what somebody needs *after* they have decided to
 * use this, and putting them here asks a reader still working out what the
 * product is to read an operations dashboard.
 *
 * The register is plain and the claims are checkable. Every number on this page
 * is either a link to a public chain or a thing the product refuses to do.
 */

const WHAT: { head: string; body: string }[] = [
  {
    head: 'It finds the failure before your users do',
    body: 'Nonces, balances, receipts and simulation results are read continuously for every address and workflow you name. Ten checks decide whether something is wrong, and each compares a measured value against a threshold — so a detection can be argued with rather than merely trusted.',
  },
  {
    head: 'It tells you what broke, evidence first',
    body: 'Every incident opens with the numbers it was judged on: the nonce that never filled, the bid against the market, the balance against the cost of the next action. The written explanation sits after them and is labelled as prose, so it can never be mistaken for a measurement.',
  },
  {
    head: 'It fixes it, with a transaction you can look up',
    body: 'A fix executes through KeeperHub as a real transaction, or is planned for your own wallet to sign where Blackbox holds no key — recorded as the weaker claim that is. There are no simulated remediations anywhere in the product.',
  },
];

const STEPS: { n: string; head: string; body: string }[] = [
  {
    n: '01',
    head: 'Connect, read-only',
    body: 'Authorise Blackbox on KeeperHub’s own page. It asks for read access and nothing else, and no credential of yours is ever typed into this site.',
  },
  {
    n: '02',
    head: 'Choose what it watches',
    body: 'Pick from your own workflows. Nothing is watched until you say so, and a workflow belonging to another account is refused rather than believed.',
  },
  {
    n: '03',
    head: 'It watches, and tells you',
    body: 'Executions are read as they finish. When a check fires you get the incident, the evidence and an explanation — by email, by webhook, or here.',
  },
  {
    n: '04',
    head: 'You decide what it may fix',
    body: 'Remediation answers only to the account that owns the agent, inside a budget you set, on the chains you allow. Everything else is a diagnosis.',
  },
];

/**
 * The proof is deliberately the transactions and not a claim about them. Each
 * hash is a real one on a public chain, so the link is the argument.
 */
const RECEIPTS: { what: string; hash: string; href: string }[] = [
  {
    what: 'A KeeperHub workflow Blackbox wrote and ran paused a failing agent',
    hash: '0x783823d5',
    href: 'https://sepolia.etherscan.io/tx/0x783823d5ee3afa43222b7ff432faeb45e1e3285d54673ab5b6af5b907248c9a9',
  },
  {
    what: 'Blackbox filled a nonce gap it detected, unwedging the signer',
    hash: '0xb1982439',
    href: 'https://sepolia.etherscan.io/tx/0xb198243930fc745817914dd6ff4fee5e57d4a357b7c632b55743dafd292a57ed',
  },
  {
    what: "A user's wallet signed a fix Blackbox planned, which Blackbox then verified",
    hash: '0x59563255',
    href: 'https://sepolia.etherscan.io/tx/0x5956325573c201d473812a08d0b0aeb96d2c3bace24954835bfda62e0e08d22e',
  },
  {
    what: 'A call that simulated clean and reverted one block later',
    hash: '0xa0dbdb74',
    href: 'https://sepolia.etherscan.io/tx/0xa0dbdb74dc0f19bdcfb6a8cc983b36a9fdbc548af0c716d363500befb45901c6',
  },
  {
    what: 'An agent paid for a diagnosis over x402 — USDC settled on Base',
    hash: '0x8cd8d6ac',
    href: 'https://basescan.org/tx/0x8cd8d6ac5dae125e5f3cf039db1ffb7f6b7dafa44243396d00e30074a93a51f9',
  },
  {
    what: 'A watched wallet ran itself down to no runway, and was told so',
    hash: '0x5aa0a47c',
    href: 'https://sepolia.etherscan.io/tx/0x5aa0a47c64c7030e3e72dbc5a114cd3ff3c2161c6042ac9aefbe573aa1852070',
  },
];

/**
 * Said on the front page rather than discovered later. A product that names
 * what it cannot do is easier to believe about what it can, and each of these
 * is a real boundary in the code rather than a caveat.
 */
const LIMITS: string[] = [
  'Watching any address gives you detection and explanation. Fixing needs a key, a KeeperHub managed wallet, or your own signature — for everything else this is a diagnosis, not a repair.',
  'Discovery starts when you register an address. Nothing that happened before that will appear.',
  'Remediation runs only on chains you allowlist, under a per-agent daily cap and an hourly gas budget.',
  'Disconnecting deletes Blackbox’s copy of your credential. It cannot revoke it at KeeperHub, because they expose no way to.',
];

/**
 * What the one action on the page should say.
 *
 * A visitor is being asked to connect; somebody already connected is being
 * shown their own product, and telling them to connect an account they have
 * connected reads as a page that does not know who is looking at it. The
 * middle case is the one worth catching — connected but watching nothing does
 * not work yet, and the front page is a reasonable place to say so.
 *
 * `connections.mine` comes from /api/config, which answers differently once
 * there is a session, so no extra request is needed to know any of this.
 */
export function callToAction(config: AppConfig | null): { to: string; label: string } | null {
  const connections = config?.connections;
  if (!connections || connections.available === false) return null;

  const mine = connections.mine;
  if (!mine) return { to: '/connections', label: 'Connect your KeeperHub account' };
  if (mine.watching === 0) return { to: '/connections', label: 'Choose what it watches' };
  return { to: '/dashboard', label: 'Open the console' };
}

export function Landing(): React.JSX.Element {
  const { config } = useConsole();
  const cta = callToAction(config);

  return (
    <div className="page landing">
      <section className="landing__hero">
        <p className="eyebrow eyebrow--accent">Incident response for onchain agents</p>
        <h1 className="landing__headline">Agents are good at reasoning and bad at execution.</h1>
        <p className="landing__lead">
          A nonce gap wedges a signer and every action behind it stops. A gas estimate goes stale
          and the transaction sits. A call simulates clean and reverts on inclusion. A retry loop
          quietly burns a wallet down. None of it raises an error the agent knows how to report, so
          you find out from a user — or from the balance.
        </p>
        <p className="landing__lead">
          Blackbox watches the execution, works out what went wrong, explains it with the numbers it
          judged, and fixes it with a real transaction.
        </p>

        <div className="landing__cta">
          {cta ? (
            <Link to={cta.to} className="button button--go landing__cta-main">
              {cta.label}
            </Link>
          ) : null}
          {/* The second door stays, unless it is already the first one. */}
          {cta?.to === '/dashboard' ? null : (
            <Link to="/dashboard" className="landing__cta-alt">
              or watch it working on ours →
            </Link>
          )}
        </div>

        <p className="landing__who">
          For teams running agents that transact — keepers, treasury automation, rebalancing and
          trading bots. Nothing is installed on the agent’s side.
        </p>
      </section>

      <section>
        <h2 className="eyebrow eyebrow--ruled">What it does</h2>
        <div className="landing__what">
          {WHAT.map((item) => (
            <article key={item.head} className="landing__whatitem">
              <h3 className="landing__whathead">{item.head}</h3>
              <p className="landing__whatbody">{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="eyebrow eyebrow--ruled">Getting started</h2>
        <ol className="landing__steps">
          {STEPS.map((step) => (
            <li key={step.n} className="landing__step">
              <span className="landing__step-n">{step.n}</span>
              <h3 className="landing__step-head">{step.head}</h3>
              <p className="landing__step-body">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="eyebrow eyebrow--ruled">What it will not do</h2>
        <ul className="landing__limits">
          {LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="eyebrow eyebrow--ruled">Receipts</h2>
        <p className="landing__note">
          Each of these was produced by the system end to end, on a public chain. The link is the
          argument.
        </p>
        <div className="tablewrap">
          <table className="landing__proof">
            <thead>
              <tr>
                <th scope="col">What happened</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {RECEIPTS.map((row) => (
                <tr key={row.hash}>
                  <td className="landing__proof-what">{row.what}</td>
                  <td>
                    <a href={row.href} target="_blank" rel="noreferrer noopener">
                      {row.hash}… ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="landing__foot">
        <p className="landing__note">
          Built on <a href="https://keeperhub.com">KeeperHub</a>. Detection is deterministic: no
          model decides whether something is wrong.
        </p>
        <Link to="/dashboard">Open the console →</Link>
      </footer>
    </div>
  );
}
