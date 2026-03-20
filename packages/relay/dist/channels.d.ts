/**
 * Channel Manager
 *
 * In-memory pub-sub channel management. No database or Redis dependencies.
 */
import { MessageEnvelope } from '@gossip/types';
import { AgentConnection } from './agent-connection';
export interface SubscribeResult {
    success: boolean;
    channelName: string;
    subscriberCount: number;
    wasCreated: boolean;
    error?: string;
    errorCode?: string;
}
export interface UnsubscribeResult {
    success: boolean;
    channelName: string;
    subscriberCount: number;
    wasDeleted: boolean;
    error?: string;
    errorCode?: string;
}
export interface BroadcastResult {
    success: boolean;
    channelName: string;
    subscriberCount: number;
    deliveredCount: number;
    failedCount: number;
    errors: Array<{
        agentId: string;
        error: string;
    }>;
}
export declare class ChannelManager {
    private channels;
    subscribe(channelName: string, agentId: string, connection: AgentConnection): SubscribeResult;
    unsubscribe(channelName: string, agentId: string): UnsubscribeResult;
    unsubscribeAll(agentId: string): string[];
    broadcast(channelName: string, envelope: MessageEnvelope): BroadcastResult;
    getSubscribers(channelName: string): string[];
    isSubscribed(channelName: string, agentId: string): boolean;
    getChannelCount(): number;
    getChannelNames(): string[];
    clear(): void;
}
