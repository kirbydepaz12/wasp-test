// Worker and Wrangler support "manual" redirect mode, not "error".
// Refuse redirects explicitly so upstream peers cannot reroute any request to
// a different origin, including opaque redirects in restricted runtimes.
export function requireNoRedirect(response) {
  const status=Number(response?.status)||0;
  if ((status>=300 && status<400) || response?.type==='opaqueredirect' || response?.redirected===true) {
    throw new Error('Upstream redirect refused' + (status ? ' (HTTP '+status+')' : ''));
  }
  return response;
}
