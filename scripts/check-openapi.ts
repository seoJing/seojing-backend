import { buildApp } from "../src/app.js";

const app = await buildApp();
const response = await app.inject({
  method: "GET",
  url: "/openapi.json",
});

if (response.statusCode !== 200) {
  throw new Error(`OpenAPI JSON returned ${response.statusCode}`);
}

const body: unknown = response.json();
if (!body || typeof body !== "object" || !("openapi" in body)) {
  throw new Error("OpenAPI document is missing the openapi field");
}

await app.close();
console.log("OpenAPI document generated");
