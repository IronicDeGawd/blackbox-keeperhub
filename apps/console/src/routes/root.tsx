import { useEffect } from 'react';
import { Link, Outlet, createRootRoute, useRouterState } from '@tanstack/react-router';
import { store, useConsole } from '../lib/store';
import { ChainBanner, ConnectionDot, MainnetWarning, Rail, StatsStrip } from '../ui/shell';
import { SessionControl } from '../ui/SessionControl';
import { adoptSessionFromFragment } from '../lib/session';
import '../ui/shell.css';

/**
 * The shell every page sits inside: masthead, stats strip, chain banner and the
 * live indicator above a scrolling main column.
 *
 * Config and stats are loaded once here. The stream is opened by the store the
 * moment anything subscribes, and closed when the last subscriber leaves.
 *
 * The front page is the exception and gets none of the instruments. Open
 * incident counts, a chain list and a stream indicator are what an operator
 * needs while something is going wrong; to somebody arriving to find out what
 * this is, they are the dashboard of a tool they have not chosen yet.
 */
function Shell(): React.JSX.Element {
  const { config, stats, connection } = useConsole();
  const isFront = useRouterState({ select: (s) => s.location.pathname === '/' });

  useEffect(() => {
    /**
     * "Connect KeeperHub" returns the operator with `#token=…&orgId=…` in the
     * fragment — browsers do not send fragments to servers and proxies do not
     * log them, which is why the API puts it there. Taken and erased at once,
     * so a live credential does not sit in the address bar or in history.
     */
    if (adoptSessionFromFragment(window.location)) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    store.start();
  }, []);

  const chains = config?.chains ?? [];

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="masthead">
        <div className="masthead__bar">
          <Link to="/" className="brand">
            Black<span className="brand__mark">box</span>
          </Link>
          {isFront ? null : <ChainBanner chains={chains} />}
          <span className="masthead__spacer" />
          {isFront ? (
            <Link to="/dashboard" className="masthead__link">
              Open the console
            </Link>
          ) : null}
          <SessionControl capabilities={config?.capabilities ?? null} />
          {isFront ? null : <ConnectionDot state={connection} />}
        </div>
        <MainnetWarning
          chains={chains}
          remediableChainIds={config?.remediation.chainAllowlist ?? []}
        />
        {isFront ? null : <StatsStrip stats={stats} />}
      </header>

      <div className={isFront ? 'body body--wide' : 'body'}>
        {isFront ? null : <Rail capabilities={config?.capabilities ?? null} />}
        <main className="shell__main" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Shell });
