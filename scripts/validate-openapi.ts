const document = await Bun.file(new URL("../openapi.json", import.meta.url)).json();
if (document.openapi !== "3.1.0" || !document.info?.title || !document.paths) throw new Error("Invalid OpenAPI document");
console.log(`OpenAPI ${document.info.version}: ${Object.keys(document.paths).length} paths`);
