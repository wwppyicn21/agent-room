import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API = "http://127.0.0.1:8787";
const OWNER = "owner@example.com";

async function call(
  request: APIRequestContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  email: string,
  data?: unknown,
) {
  const response = await request.fetch(`${API}${path}`, {
    method,
    headers: {
      "x-dev-user-email": email,
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    data,
  });
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()} ${await response.text()}`);
  }
  return response.status() === 204 ? null : await response.json();
}

async function createGroup(request: APIRequestContext): Promise<{ id: string; name: string }> {
  const name = `E2E ${Date.now()} ${Math.random().toString(16).slice(2, 6)}`;
  const body = await call(request, "POST", "/api/v1/groups", OWNER, { name });
  return body.group;
}

async function login(page: Page, email = OWNER): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("owner@example.com").fill(email);
  await page.getByRole("button", { name: "进入" }).click();
  await expect(page.getByRole("heading", { name: "群组", exact: true })).toBeVisible();
}

async function openGroup(page: Page, groupName: string): Promise<void> {
  await page.locator(".group-item", { hasText: groupName }).click();
  await expect(page.locator(".topbar h1")).toHaveText(groupName);
}

test("logs in and lists the groups the user may access", async ({ page, request }) => {
  const group = await createGroup(request);
  await login(page);
  await expect(page.locator(".group-item", { hasText: group.name })).toBeVisible();
});

test("sends a message and shows it once after the realtime echo", async ({ page, request }) => {
  const group = await createGroup(request);
  await login(page);
  await openGroup(page, group.name);
  const text = `hello e2e ${Date.now()}`;
  await page.getByPlaceholder(/的身份发言/).fill(text);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
});

test("deduplicates a repeated clientMessageId in the browser", async ({ page, request }) => {
  const group = await createGroup(request);
  const text = `dedupe ${Date.now()}`;
  await call(request, "POST", `/api/v1/groups/${group.id}/messages`, OWNER, {
    content: text,
    clientMessageId: "e2e-dedupe-1",
  });
  await call(request, "POST", `/api/v1/groups/${group.id}/messages`, OWNER, {
    content: text,
    clientMessageId: "e2e-dedupe-1",
  });
  await login(page);
  await openGroup(page, group.name);
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
});

test("reconnects the realtime socket and recovers messages sent while offline", async ({
  page,
  request,
}) => {
  test.slow();
  const group = await createGroup(request);
  await login(page);
  await openGroup(page, group.name);
  await expect(page.getByText("实时已连接")).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __roomRealtime: { dropConnection(): void } }
    ).__roomRealtime.dropConnection();
  });
  await page.waitForTimeout(300);
  const text = `recovered ${Date.now()}`;
  await call(request, "POST", `/api/v1/groups/${group.id}/messages`, OWNER, { content: text });
  await expect(page.getByText("实时已连接")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("creates and opens a thread and a task from a group message", async ({ page, request }) => {
  const group = await createGroup(request);
  const source = await call(request, "POST", `/api/v1/groups/${group.id}/messages`, OWNER, {
    content: "source for thread",
  });
  await login(page);
  await openGroup(page, group.name);

  await page.getByRole("button", { name: "Thread", exact: true }).click();
  await page.getByText("从群消息创建 Thread").click();
  await page.getByLabel("来源消息 ID").fill(source.message.id);
  await page.getByLabel("标题").fill("E2E thread");
  await page.locator("details").getByRole("button", { name: "创建" }).click();
  await expect(page.getByText("E2E thread", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByText("从群消息创建任务").click();
  await page.getByLabel("来源消息 ID").fill(source.message.id);
  await page.getByLabel("标题").fill("E2E task");
  await page.locator("details").getByRole("button", { name: "创建" }).click();
  await expect(page.getByText("E2E task", { exact: true })).toBeVisible();
});

test("a removed member loses access and receives no further group messages", async ({
  browser,
  request,
}) => {
  const group = await createGroup(request);
  const member = `member-${Date.now()}@example.com`;
  const created = await call(request, "POST", "/api/v1/users", OWNER, {
    displayName: "E2E Member",
    email: member,
    role: "member",
  });
  await call(request, "POST", `/api/v1/groups/${group.id}/members`, OWNER, {
    memberType: "user",
    memberId: created.user.id,
  });

  const memberPage = await browser.newPage();
  await login(memberPage, member);
  await openGroup(memberPage, group.name);
  await expect(memberPage.locator(".topbar h1")).toHaveText(group.name);

  await call(
    request,
    "DELETE",
    `/api/v1/groups/${group.id}/members/user/${created.user.id}`,
    OWNER,
  );
  const forbidden = await request.fetch(`${API}/api/v1/groups/${group.id}/messages`, {
    headers: { "x-dev-user-email": member },
  });
  expect(forbidden.status()).toBe(403);

  const text = `after removal ${Date.now()}`;
  await call(request, "POST", `/api/v1/groups/${group.id}/messages`, OWNER, { content: text });
  await memberPage.waitForTimeout(1_500);
  await expect(memberPage.getByText(text, { exact: true })).toHaveCount(0);
  await memberPage.reload();
  await expect(memberPage.locator(".group-item", { hasText: group.name })).toHaveCount(0);
  await memberPage.close();
});
