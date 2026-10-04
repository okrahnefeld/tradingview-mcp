const allow = process.env.TV_ALLOW_LIVE_MUTATION === '1';
if (!allow) {
  console.error(
    'Refusing live TradingView E2E suite. Set TV_ALLOW_LIVE_MUTATION=1 only when the MCP is attached to a proven isolated non-protected target.'
  );
  process.exit(2);
}
