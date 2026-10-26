import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseTypeBoxValue } from "../shared/typebox.ts";
import { HOST_SCHEMA, HOSTS_CHANNEL, type Host } from "./contract.ts";

const RESERVED_NAMES = new Set([
  "left",
  "right",
  "up",
  "down",
  "deferred",
  "subagent",
  "tmux",
  "ghostty",
  "herdr",
]);

export class HostRegistry {
  private hosts: readonly Host[] = [];

  discover(events: ExtensionAPI["events"]): void {
    const hosts: Host[] = [];
    let frozen = false;
    let registrationError: unknown;
    this.hosts = [];
    try {
      events.emit(HOSTS_CHANNEL, {
        register(value: unknown) {
          if (frozen) throw new Error("Host registration is closed.");
          try {
            const host = parseTypeBoxValue(HOST_SCHEMA, value, "Invalid host");
            if (RESERVED_NAMES.has(host.name) || hosts.some((entry) => entry.name === host.name)) {
              throw new Error(`Host name is reserved or already registered: ${host.name}`);
            }
            hosts.push(Object.freeze({ ...host }));
          } catch (error) {
            registrationError = error;
            throw error;
          }
        },
      });
    } finally {
      frozen = true;
    }
    // Pi logs listener errors instead of propagating them through emit.
    if (registrationError) throw registrationError;
    this.hosts = Object.freeze(hosts);
  }

  getHosts(): readonly Host[] {
    return this.hosts;
  }

  claimsPeers(): boolean {
    return this.hosts.length > 0;
  }

  claimsRecall(): boolean {
    return this.hosts.some((host) => host.recall === true);
  }
}
