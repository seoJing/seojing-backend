import type { GitHubUserIdentity } from "../repositories/community.js";
import type { AuthSession, CommunityService } from "./community.js";

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl?: string;
}

export interface GitHubOAuthExchangeInput {
  code: string;
  redirectUri?: string;
}

interface GitHubAccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
}

export class GitHubOAuthService {
  constructor(
    private readonly config: GitHubOAuthConfig,
    private readonly communityService: CommunityService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(state?: string, redirectUri?: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("scope", "read:user");
    if (state) {
      url.searchParams.set("state", state);
    }
    const finalRedirectUri = redirectUri ?? this.config.callbackUrl;
    if (finalRedirectUri) {
      url.searchParams.set("redirect_uri", finalRedirectUri);
    }
    return url.toString();
  }

  async exchangeCode(input: GitHubOAuthExchangeInput): Promise<AuthSession> {
    const token = await this.requestAccessToken(input);
    const identity = await this.fetchGitHubUser(token);
    return this.communityService.createSession(identity);
  }

  private async requestAccessToken(
    input: GitHubOAuthExchangeInput,
  ): Promise<string> {
    const response = await this.fetchImpl(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri ?? this.config.callbackUrl,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub OAuth token request failed: ${response.status}`);
    }
    const payload = (await response.json()) as GitHubAccessTokenResponse;
    if (payload.error || !payload.access_token) {
      throw new Error(
        payload.error_description ?? payload.error ?? "GitHub OAuth failed.",
      );
    }
    return payload.access_token;
  }

  private async fetchGitHubUser(token: string): Promise<GitHubUserIdentity> {
    const response = await this.fetchImpl("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "seojing-backend",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub user request failed: ${response.status}`);
    }
    const payload = (await response.json()) as GitHubUserResponse;
    if (!payload.id || !payload.login) {
      throw new Error("GitHub user payload is missing id/login.");
    }
    return {
      githubId: String(payload.id),
      githubLogin: payload.login,
      displayName: payload.name ?? undefined,
      avatarUrl: payload.avatar_url ?? undefined,
      profileUrl: payload.html_url ?? `https://github.com/${payload.login}`,
    };
  }
}
