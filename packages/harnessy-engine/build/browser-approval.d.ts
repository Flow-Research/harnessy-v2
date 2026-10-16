export type McpElicitationMode = "browser" | "model" | "native";
export declare const readElicitationMode: (request: Request) => McpElicitationMode;
