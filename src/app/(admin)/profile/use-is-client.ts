import * as React from "react";

const subscribeNothing = () => () => {};

/**
 * False during the server render and hydration, true after. For values only the
 * browser knows: the viewer's timezone and the theme saved in local storage.
 */
export function useIsClient(): boolean {
  return React.useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}
