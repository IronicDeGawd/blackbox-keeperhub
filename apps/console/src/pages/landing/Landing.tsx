import { Link } from '@tanstack/react-router';
import { useConsole } from '../../lib/store';
import { DemoButton } from '../../ui/DemoButton';
import type { Capabilities } from '../../lib/types';
import './landing.css';

/**
 * The entry point. Someone arriving cold on the public URL used to get an
 * incident list with no statement of what they were looking at, which reads as
 * a screenshot rather than a product.
 *
 * It is still the same object as the rest of the console — hairlines, mono
 * labels, no decorative card and no hero gradient. The only thing it adds is
 * the sentence the timeline could not say for itself.
 */

type Destination = {
  to: string;
  label: string;
  line: string;
  needs?: keyof Capabilities;
};

const DESTINATIONS: Destination[] = [
  {
    to: '/timeline',
    label: 'Timeline',
    line: 'Every incident as it is detected, newest first, with the filters held in the URL so a view can be pasted to someone else.',
  },
  {
    to: '/incidents',
    label: 'Incidents',
    line: 'The same incidents as a table, with who resolved each one as its own column.',
  },
  {
    to: '/inspect',
    label: 'Inspect',
    line: 'Paste a transaction hash and get a verdict. No account, no setup, nothing to register first.',
    needs: 'diagnose',
  },
  {
    to: '/watched',
    label: 'Watched',
    line: 'Register an address so its execution is read. What watching does not give you is stated on the page.',
  },
  {
    to: '/chaos',
    label: 'Chaos',
    line: 'Break something on a testnet on purpose, then watch it get caught, explained and fixed.',
    // `signChaos`, not `chaos`: the public deployment holds no key, so the
    // panel it *can* offer is the one the visitor signs themselves.
    needs: 'signChaos',
  },
];

/**
 * The proof is deliberately the transactions and not a claim about them. Each
 * hash is a real one on a public chain, so the link is the argument.
 */
const PROOF: { what: string; hash: string; href: string }[] = [
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
    what: 'Chaos: a call that simulated clean and reverted one block later',
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

const STEPS: { n: string; head: string; body: string }[] = [
  {
    n: '01',
    head: 'Watch',
    body: 'Nonces, balances, receipts and simulation results are read for every watched signer on every configured chain.',
  },
  {
    n: '02',
    head: 'Detect',
    body: 'Ten rules, R1 to R10, fire on measured facts — including three that only a KeeperHub-managed wallet can trigger. Detection is deterministic: no model decides whether something is wrong.',
  },
  {
    n: '03',
    head: 'Explain',
    body: 'The evidence comes first: each measured value beside the threshold it was compared against. The written summary sits after it, boxed and labelled.',
  },
  {
    n: '04',
    head: 'Fix',
    body: 'The remediation executes through KeeperHub as a real transaction, or is planned for a wallet to sign — which is recorded as the weaker claim it is.',
  },
];

export function Landing(): React.JSX.Element {
  const { config } = useConsole();
  const capabilities = config?.capabilities ?? null;

  const visible = DESTINATIONS.filter(
    (destination) => !destination.needs || capabilities?.[destination.needs] !== false,
  );

  return (
    <div className="page landing">
      <section className="landing__statement">
        <p className="eyebrow eyebrow--accent">Blackbox</p>
        <h1 className="landing__headline">
          Agents are good at reasoning and bad at execution.
        </h1>
        <p className="landing__lead">
          Nonce gaps wedge signers, gas estimates go stale, transactions simulate clean and revert
          on inclusion, and a retry loop quietly burns a wallet down. Blackbox watches onchain agent
          execution, works out what went wrong, explains it, and fixes it with a real transaction.
        </p>
        <p className="panel panel--accent landing__claim">
          Every remediation is a real transaction with a retrievable hash. There are no simulated
          remediations anywhere in the product.
        </p>
        {capabilities?.demo ? <DemoButton /> : null}
      </section>

      <section>
        <h2 className="eyebrow eyebrow--ruled">How it works</h2>
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
        <h2 className="eyebrow eyebrow--ruled">Start here</h2>
        <ul className="landing__destinations">
          {visible.map((destination) => (
            <li key={destination.to} className="landing__destination">
              <Link to={destination.to} className="landing__destination-link">
                {destination.label}
              </Link>
              <p className="landing__destination-line">{destination.line}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="eyebrow eyebrow--ruled">Proof onchain</h2>
        <p className="landing__note">
          Produced by the system end to end on public testnets. Every hash resolves.
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
              {PROOF.map((row) => (
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
    </div>
  );
}
