export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/check") {
      const secretOk = env.TEST_SECRET === "hello-test";
      let kvOk = false;
      try {
        await env.TEST_KV.put("probe", "1");
        const v = await env.TEST_KV.get("probe");
        kvOk = v === "1";
      } catch (e) {}
      return Response.json({ secretOk, kvOk, version: "test-v1" });
    }
    return Response.json({ ok: true, version: "test-v1" });
  }
};
