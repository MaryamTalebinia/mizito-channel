export function scriptedFetch(steps: Array<() => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps.shift();
    if (!step) throw new Error("no scripted response left");
    return step();
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const html = (body: string, status = 200) => () =>
  new Response(body, { status, headers: { "content-type": "text/html" } });
