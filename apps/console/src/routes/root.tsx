import { useEffect } from 'react';
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { store, useConsole } from '../lib/store';
import { ChainBanner, ConnectionDot, MainnetWarning, Rail, StatsStrip } from '../ui/shell';
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
    store.start();
  }, []);

  const chains = config?.chains ?? [];

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead__bar">
          <span className="brand">
            Black<span className="brand__mark">box</span>
          </span>
          <ChainBanner chains={chains} />
          <span className="masthead__spacer" />
          <ConnectionDot state={connection} />
        </div>
        <MainnetWarning chains={chains} />
        <StatsStrip stats={stats} />
      </header>

      <div className="body">
        <Rail capabilities={config?.capabilities ?? null} />
        <main className="shell__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Shell });
