import { ContainerMeta } from "@/types";
import { Queue } from "bullmq";

export const destroyContainerQueue = new Queue("destroy-containers", {
    connection: {
        url: process.env.REDIS_URL,
    },
});

export async function scheduleDestroy(meta: ContainerMeta): Promise<string> {
    const job = await destroyContainerQueue.add(
        "destroy-container",
        {
            instanceId: meta.id,
            containerId: meta.containerId,
            dbType: meta.dbType,
            scheduledAt: new Date().toISOString(),
        },
        {
            delay: meta.ttl * 1000, // BullMQ delay is in ms
            attempts: 3,
            backoff: {
                type: "exponential",
                delay: 5000,
            },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
            jobId: `destroy-${meta.id}`, // idempotent — same instance → same job id
        }
    );

    return job.id!;
}