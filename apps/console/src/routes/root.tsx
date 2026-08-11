import { useEffect } from 'react';
import { Outlet, createRootRoute } from '@tanstack/react-router';
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
 */
function Shell(): React.JSX.Element {
  const { config, stats, connection } = useConsole();

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
      {/* Six rail links sit before the content on every page. */}
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="masthead">
        <div className="masthead__bar">
          <span className="brand">
            Black<span className="brand__mark">box</span>
          </span>
          <ChainBanner chains={chains} />
          <span className="masthead__spacer" />
          <SessionControl capabilities={config?.capabilities ?? null} />
          <ConnectionDot state={connection} />
        </div>
        <MainnetWarning chains={chains} />
        <StatsStrip stats={stats} />
      </header>

      <div className="body">
        <Rail capabilities={config?.capabilities ?? null} />
        <main className="shell__main" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Shell });
