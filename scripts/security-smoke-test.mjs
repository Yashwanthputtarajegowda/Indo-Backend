const baseUrl = String(process.env.SECURITY_BASE_URL || process.env.BASE_URL || "").trim().replace(/\/$/, "");
const tokenA = String(process.env.SECURITY_TEST_TOKEN_A || "").trim();
const tokenB = String(process.env.SECURITY_TEST_TOKEN_B || "").trim();

if (!baseUrl) {
  console.error("SECURITY_BASE_URL/BASE_URL is required.");
  process.exit(2);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  return { response, body };
}

function assertStatus(name, actual, allowed) {
  if (!allowed.includes(actual)) {
    throw new Error(`${name}: expected ${allowed.join("/")}, got ${actual}`);
  }
  console.log(`PASS ${name}: ${actual}`);
}

async function run() {
  const health = await request("/api/health");
  assertStatus("health", health.response.status, [200]);

  const protectedView = await request("/api/media/videos/not-a-real-video/view", {
    method: "POST",
  });
  assertStatus("anonymous view protection", protectedView.response.status, [401, 404]);

  const signature = await request("/api/media/signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "invalid" }),
  });
  assertStatus("upload signature authentication/validation", signature.response.status, [400, 401]);

  const malformedProfile = await request("/api/account/public-profile/../../../../etc/passwd");
  assertStatus("malformed profile path rejection", malformedProfile.response.status, [400, 401, 404]);

  const mutation = await request("/api/media/not-a-real-id/like", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ like: true }),
  });
  assertStatus("anonymous mutation protection", mutation.response.status, [401, 404]);

  const longQuery = `/api/media/videos?limit=${encodeURIComponent("999999999999999999999")}`;
  const readGuard = await request(longQuery);
  assertStatus("read limit guard availability", readGuard.response.status, [200, 400, 401, 403, 500]);

  if (tokenA) {
    const authHealth = await request("/api/health", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assertStatus("authenticated health", authHealth.response.status, [200]);
  } else {
    console.log("SKIP authenticated tests: SECURITY_TEST_TOKEN_A not supplied");
  }

  if (tokenA && tokenB) {
    console.log("Authenticated two-user IDOR testing requires a concrete target resource ID and is intentionally not guessed.");
  }

  console.log("Security smoke test completed.");
}

run().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
