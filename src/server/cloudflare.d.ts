/**
 * The `cloudflare:workers` module, declared narrowly on purpose.
 *
 * `wrangler types` writes a `worker-configuration.d.ts` that declares this
 * module *and* the whole workerd global scope. That second half is unusable
 * here: workerd's globals merge with the DOM lib this project compiles
 * against, and its `Element.append(content: string | ReadableStream |
 * Response)` overload then wins over the DOM's `append(...nodes: Node[])` —
 * measured, it breaks every `document.head.append(style)` in src/lib/theme,
 * src/lib/fonts and src/lib/images.
 *
 * So only the module is declared, with only the bindings the server routes
 * actually read, which is the same stance tsconfig.node.json has always taken
 * about `@cloudflare/workers-types`: import what is needed, never install the
 * globals. Keep this in step with the bindings and vars in wrangler.jsonc.
 */
declare module 'cloudflare:workers' {
  export const env: {
    /** The sync database. See the `d1_databases` block in wrangler.jsonc. */
    DB?: import('@cloudflare/workers-types').D1Database
    /** Public, and also baked into the client bundle. From `vars`. */
    CLERK_PUBLISHABLE_KEY?: string
    /** Comma-separated origins allowed to mint tokens. From `vars`. */
    CLERK_AUTHORIZED_PARTIES?: string
    /** Secret: `wrangler secret put`, or `.dev.vars` locally. */
    CLERK_SECRET_KEY?: string
    /** Secret: the PEM public key, for networkless verification. */
    CLERK_JWT_KEY?: string
    /** Secret: Polar organization access token. */
    POLAR_ACCESS_TOKEN?: string
    /** Secret: signs incoming Polar webhooks. */
    POLAR_WEBHOOK_SECRET?: string
    /** The Sync plan's Polar product id. From `vars`. */
    POLAR_PRODUCT_ID?: string
    /** `sandbox` or `production`. From `vars`. */
    POLAR_SERVER?: string
    /** This deployment's public origin, for outbound User-Agent contact. From `vars`. */
    APP_ORIGIN?: string
  }
}
