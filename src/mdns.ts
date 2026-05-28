import { useCallback, useEffect, useState } from "react";
import Zeroconf from "react-native-zeroconf";

export type DiscoveredServer = {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  password: string;
};

type Service = {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, string | undefined>;
  fullName?: string;
};

export function useMdnsServers() {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [searching, setSearching] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchID, setSearchID] = useState(0);
  const search = useCallback(() => setSearchID((value) => value + 1), []);

  useEffect(() => {
    const browsers: Zeroconf[] = [];
    let mounted = true;
    if (typeof Zeroconf !== "function") {
      setSearching(false);
      setUnavailable(true);
      setError(null);
      return;
    }
    setSearching(true);
    setUnavailable(false);
    setError(null);

    function addServer(service: Service, type: string) {
      const server = serverFromService(service, type);
      if (!server || !mounted) return;
      setServers((current) => {
        const index = current.findIndex((item) => item.id === server.id || item.baseUrl === server.baseUrl);
        if (index === -1) return [...current, server].sort((left, right) => left.name.localeCompare(right.name));
        const next = [...current];
        next[index] = server;
        return next;
      });
    }

    for (const type of ["opencode", "http"]) {
      try {
        const zeroconf = new Zeroconf();
        if (typeof zeroconf.scan !== "function") {
          setSearching(false);
          setUnavailable(true);
          setError(null);
          return;
        }
        zeroconf.on("start", () => mounted && setSearching(true));
        zeroconf.on("stop", () => mounted && setSearching(false));
        zeroconf.on("resolved", (service: unknown) => addServer(service as Service, type));
        zeroconf.on("error", (cause: unknown) => {
          if (!mounted) return;
          setSearching(false);
          setError(cause instanceof Error ? cause.message : "mDNS discovery failed");
        });
        zeroconf.scan(type, "tcp", "local.");
        browsers.push(zeroconf);
      } catch {
        setSearching(false);
        setUnavailable(true);
        setError(null);
        return;
      }
    }

    const timeout = setTimeout(() => mounted && setSearching(false), 8000);
    return () => {
      mounted = false;
      clearTimeout(timeout);
      for (const browser of browsers) {
        browser.stop();
        browser.removeDeviceListeners();
      }
    };
  }, [searchID]);

  return { servers, searching, unavailable, error, search };
}

function serverFromService(service: Service, type: string): DiscoveredServer | undefined {
  if (!service.port) return undefined;
  if (!serviceName(service).startsWith("opencode-")) return undefined;
  const host = preferredHost(service);
  if (!host) return undefined;
  const username = service.txt?.username || "opencode";
  const password = service.txt?.password || "";
  const name = service.name || service.host || "opencode";
  const baseUrl = `http://${urlHost(host)}:${service.port}`;
  return { id: `${name}-${baseUrl}`, name, baseUrl, username, password };
}

function serviceName(service: Service) {
  return (service.name || "").toLowerCase();
}

function preferredHost(service: Service) {
  const address = service.addresses?.find((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item)) ?? service.addresses?.[0];
  return address || service.host?.replace(/\.$/, "");
}

function urlHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
