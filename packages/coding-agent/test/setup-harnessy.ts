/**
 * The built-in harnessy-engine extension registers three tools in every real
 * session. Upstream tests assert exact tool/extension sets against fixtures,
 * so the builtin is disabled suite-wide here; builtin-harnessy-engine.test.ts
 * re-enables it explicitly to cover the builtin itself.
 */
process.env.HARNESSY_ENGINE = "0";
