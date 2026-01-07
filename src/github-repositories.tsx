import React, { useState, useEffect } from "react";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  LocalStorage,
} from "@raycast/api";
import { withAccessToken } from "@raycast/utils";
import { fetchRepositories, Repository } from "./services/repositories";
import { provider, getOctokit } from "./lib/oauth";

const STORAGE_KEY = "repository-access-times";
const CACHE_KEY = "repositories-cache";
const CACHE_TIMESTAMP_KEY = "repositories-cache-timestamp";
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

interface RepositoryAccessTimes {
  [repoId: string]: number; // timestamp
}

async function getAccessTimes(): Promise<RepositoryAccessTimes> {
  const stored = await LocalStorage.getItem<string>(STORAGE_KEY);
  return stored ? JSON.parse(stored) : {};
}

async function updateAccessTime(repoId: string): Promise<void> {
  const accessTimes = await getAccessTimes();
  accessTimes[repoId] = Date.now();
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(accessTimes));
}

async function getCachedRepositories(): Promise<Repository[] | null> {
  const cached = await LocalStorage.getItem<string>(CACHE_KEY);
  if (!cached) return null;
  return JSON.parse(cached);
}

async function setCachedRepositories(repos: Repository[]): Promise<void> {
  await LocalStorage.setItem(CACHE_KEY, JSON.stringify(repos));
  await LocalStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
}

async function isCacheValid(): Promise<boolean> {
  const timestamp = await LocalStorage.getItem<string>(CACHE_TIMESTAMP_KEY);
  if (!timestamp) return false;
  const age = Date.now() - parseInt(timestamp, 10);
  return age < CACHE_DURATION;
}

function sortRepositoriesByAccess(
  repos: Repository[],
  accessTimes: RepositoryAccessTimes,
): Repository[] {
  return [...repos].sort((a, b) => {
    const aTime = accessTimes[a.id] || 0;
    const bTime = accessTimes[b.id] || 0;
    // Recently accessed repos first
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    // Fall back to original usage score
    return b.usageScore - a.usageScore;
  });
}

function MyRepositoriesCommand() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [sortedRepositories, setSortedRepositories] = useState<Repository[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string>("");
  const [, setAccessTimes] = useState<RepositoryAccessTimes>({});

  useEffect(() => {
    async function loadRepositories() {
      try {
        const times = await getAccessTimes();

        // Load cached data first if available
        const cachedRepos = await getCachedRepositories();
        if (cachedRepos && cachedRepos.length > 0) {
          setRepositories(cachedRepos);
          setAccessTimes(times);
          setSortedRepositories(sortRepositoriesByAccess(cachedRepos, times));

          // Get current user from cache
          if (cachedRepos.length > 0 && cachedRepos[0].owner) {
            try {
              const octokit = getOctokit();
              const { data: user } = await octokit.rest.users.getAuthenticated();
              setCurrentUser(user.login);
            } catch {
              // Silently fail for user fetch
            }
          }

          // If cache is still valid, just stop loading indicator
          const cacheValid = await isCacheValid();
          if (cacheValid) {
            setIsLoading(false);
          }
        }

        // Fetch fresh data in the background (always, but don't show loading if we have cache)
        const cacheValid = await isCacheValid();
        if (!cacheValid || !cachedRepos) {
          setError(null);

          const repos = await fetchRepositories();

          // Cache the fresh data
          await setCachedRepositories(repos);

          setRepositories(repos);
          setAccessTimes(times);
          setSortedRepositories(sortRepositoriesByAccess(repos, times));

          // Get current user for categorization
          if (repos.length > 0) {
            const octokit = getOctokit();
            const { data: user } = await octokit.rest.users.getAuthenticated();
            setCurrentUser(user.login);
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load repositories";
        setError(errorMessage);
        await showToast({
          style: Toast.Style.Failure,
          title: "Error loading repositories",
          message: errorMessage,
        });
      } finally {
        setIsLoading(false);
      }
    }

    loadRepositories();
  }, []);

  const handleRepositoryClick = async (repoId: string) => {
    await updateAccessTime(repoId);
    const updatedTimes = await getAccessTimes();
    setAccessTimes(updatedTimes);
    setSortedRepositories(sortRepositoriesByAccess(repositories, updatedTimes));
  };

  const getRepositoryAccessory = (repo: Repository) => {
    const accessories: List.Item.Accessory[] = [];

    // Show organization badge if not owned by current user
    if (currentUser && repo.owner !== currentUser) {
      accessories.push({
        tag: { value: repo.owner, color: Color.Purple },
        tooltip: `Organization: ${repo.owner}`,
      });
    }

    if (repo.stars > 0) {
      accessories.push({
        icon: Icon.Star,
        text: `${repo.stars}`,
        tooltip: `${repo.stars} stars`,
      });
    }

    if (repo.isPrivate) {
      accessories.push({
        icon: Icon.Lock,
        tooltip: "Private repository",
      });
    }

    return accessories;
  };

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search your repositories..."
      navigationTitle="My GitHub Repositories"
    >
      {error ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Error loading repositories"
          description={error}
        />
      ) : sortedRepositories.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Box}
          title="No repositories found"
          description="You don't have any repositories yet"
        />
      ) : (
        sortedRepositories.map((repo) => (
          <List.Item
            key={repo.id}
            icon={`repo.png`}
            title={repo.fullName}
            subtitle={repo.description || ""}
            accessories={getRepositoryAccessory(repo)}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser
                  title="Open in Browser"
                  url={repo.url}
                  icon={Icon.Globe}
                  onOpen={() => handleRepositoryClick(repo.id)}
                />
                <Action.CopyToClipboard
                  title="Copy URL"
                  content={repo.url}
                  icon={Icon.Clipboard}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                  onCopy={() => handleRepositoryClick(repo.id)}
                />
                <Action.CopyToClipboard
                  title="Copy Repository Name"
                  content={repo.fullName}
                  icon={Icon.Text}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  onCopy={() => handleRepositoryClick(repo.id)}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

export default withAccessToken(provider)(MyRepositoriesCommand);
