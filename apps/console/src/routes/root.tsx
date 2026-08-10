import { Outlet, createRootRoute } from '@tanstack/react-router';

/**
 * The shell every page sits inside. Nav, the stats strip, the chain banner and
 * the live-connection dot land here next; for now it establishes the frame so
 * routing can be verified on its own.
 */
function Shell(): React.JSX.Element {
  return (
    <div className="shell">
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Shell });
