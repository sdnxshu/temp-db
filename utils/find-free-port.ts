import { docker } from "@/lib/docker";

export async function findFreePort(min: number, max: number): Promise<number> {
    // List currently used ports from running containers
    const containers = await docker.listContainers();
    const usedPorts = new Set<number>();

    for (const c of containers) {
        for (const p of c.Ports) {
            if (p.PublicPort) usedPorts.add(p.PublicPort);
        }
    }

    for (let port = min; port <= max; port++) {
        if (!usedPorts.has(port)) return port;
    }

    throw new Error(`No free port found in range ${min}–${max}`);
}