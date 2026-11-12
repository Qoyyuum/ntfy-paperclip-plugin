import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import pkg from "../package.json";

export const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.ntfy",
  apiVersion: 1,
  version: pkg.version,
  displayName: "ntfy Notifications",
  description:
    "Forward Paperclip events to ntfy topics. Works with ntfy.sh or a self-hosted ntfy server.",
  author: "Paperclip community",
  categories: ["connector"],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "access.members.read",
    "secrets.read-ref",
    "activity.log.write",
    "api.routes.register",
    "ui.page.register",
    "companies.read",
    "issues.read",
    "approvals.read",
    "agents.read",
    "projects.read",
    "goals.read",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        title: "ntfy base URL",
        description:
          "Base URL of the ntfy server, e.g. https://ntfy.sh or http://localhost:2580",
        default: "https://ntfy.sh",
      },
      appBaseUrl: {
        type: "string",
        title: "Paperclip app base URL",
        description:
          "Public URL of this Paperclip instance, used for Click links in notifications (e.g. https://paperclip.example.com).",
      },
      authMode: {
        type: "string",
        title: "ntfy authentication",
        enum: ["none", "token", "basic"],
        default: "none",
        description:
          "How to authenticate when publishing to ntfy. 'token' uses an ntfy access token (tk_…), 'basic' uses username + password.",
      },
      accessTokenSecretId: {
        type: "string",
        title: "Access token secret ID",
        description:
          "ID of the Paperclip secret holding the ntfy access token (used when auth is 'token').",
      },
      username: {
        type: "string",
        title: "ntfy username",
        description: "ntfy username (used when auth is 'basic').",
      },
      passwordSecretId: {
        type: "string",
        title: "Password secret ID",
        description:
          "ID of the Paperclip secret holding the ntfy password (used when auth is 'basic').",
      },
      defaultPriority: {
        type: "number",
        title: "Default priority",
        description: "Default ntfy message priority (1=min … 5=urgent).",
        minimum: 1,
        maximum: 5,
        default: 3,
      },
      defaultTags: {
        type: "string",
        title: "Default tags",
        description: "Comma-separated ntfy tags applied to every notification.",
      },
    },
  },
  apiRoutes: [
    {
      routeKey: "admin-state",
      method: "GET",
      path: "/admin/state",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "channel-upsert",
      method: "PATCH",
      path: "/admin/channels/:id",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "channel-delete",
      method: "DELETE",
      path: "/admin/channels/:id",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "subscriptions-set",
      method: "POST",
      path: "/admin/subscriptions",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "test-send",
      method: "POST",
      path: "/admin/test",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "server-status",
      method: "GET",
      path: "/admin/server-status",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "server-setup",
      method: "POST",
      path: "/admin/server-setup",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "notifications-admin",
        displayName: "ntfy Notifications",
        exportName: "NotificationsAdminPage",
        routePath: "ntfy",
      },
    ],
  },
};

export default manifest;
