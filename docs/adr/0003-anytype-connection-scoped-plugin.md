# ADR-0003: AnyType uses a connection-scoped dynamic catalog

**Status:** accepted for Track A

The integration plan described AnyType as an Executor `staticIntegrations` declaration. The current vendored Executor contract makes static tools global addresses (`anytype.spaces_list`) with no backing connection and no `ToolInvocationCredential`. Static integrations therefore cannot read the per-connection `apiKey`, `baseUrl`, or `allowRemote` values required by the AnyType security boundary.

Harnessy's AnyType plugin instead registers one built-in `anytype` integration and returns a fixed nine-tool catalog from `resolveTools`. The catalog remains fixed, but each persisted tool is connection-scoped and `invokeTool` receives the resolved credential. This preserves the intended read-only surface while using Executor's credential and policy pipeline.

The existing native adapter currently implements only `spaces_list`, `objects_search`, and `objects_get`. The other six catalog entries deliberately delegate to the corresponding Harnessy knowledge services and return their typed unsupported-capability errors until those native reads are implemented. No duplicate transport was introduced.
