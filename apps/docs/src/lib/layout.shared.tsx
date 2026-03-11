import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

const fallbackGitConfig = {
  user: "tokenspace-ai",
  repo: "tokenspace",
  branch: "main",
};

export const gitConfig = {
  user: process.env.NEXT_PUBLIC_GITHUB_OWNER ?? process.env.GITHUB_OWNER ?? fallbackGitConfig.user,
  repo: process.env.NEXT_PUBLIC_GITHUB_REPO ?? process.env.GITHUB_REPO ?? fallbackGitConfig.repo,
  branch: process.env.NEXT_PUBLIC_GITHUB_BRANCH ?? process.env.GITHUB_BRANCH ?? fallbackGitConfig.branch,
};

export function getGitHubUrl() {
  return `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Image src="/logo.svg" alt="TokenSpace" width={152} height={32} className="h-7 w-auto" priority />,
    },
    githubUrl: "https://github.com/tokenspace-ai",
  };
}
