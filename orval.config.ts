export default {
  hdu: {
    input: "./openapi.yaml",
    output: {
      target: "./src/web/generated/client.ts",
      schemas: "./src/web/generated/model",
      client: "react-query",
      mode: "tags-split",
      clean: true,
      prettier: false,
    },
  },
};
