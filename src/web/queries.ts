import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const queryKeys = {
  session: ["session"] as const,
  plans: ["plans"] as const,
  bookings: ["bookings"] as const,
  checkin: ["checkin"] as const,
  nextTarget: ["next-target"] as const,
  runtime: ["runtime"] as const,
  roomTypes: ["room-types"] as const,
  floors: (roomQuery: string, roomType?: string) => ["floors", roomQuery, roomType || ""] as const,
  durations: (roomQuery: string, startHour: number, roomType?: string) => ["durations", roomQuery, roomType || "", startHour] as const,
  audit: ["audit"] as const,
};

export function useSession() { return useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false }); }
export function usePlans() { return useQuery({ queryKey: queryKeys.plans, queryFn: api.plans }); }
export function useBookings() { return useQuery({ queryKey: queryKeys.bookings, queryFn: api.bookings, refetchInterval: 30_000 }); }
export function useNextTarget() { return useQuery({ queryKey: queryKeys.nextTarget, queryFn: api.nextTarget, refetchInterval: 30_000 }); }
export function useRuntime() { return useQuery({ queryKey: queryKeys.runtime, queryFn: api.runtime, refetchInterval: 15_000 }); }
export function useCheckin() { return useQuery({ queryKey: queryKeys.checkin, queryFn: api.checkinStatus }); }
export function useAudit(limit = 20) { return useQuery({ queryKey: queryKeys.audit, queryFn: () => api.audit(limit), refetchInterval: 15_000 }); }
export function useRoomTypes() { return useQuery({ queryKey: queryKeys.roomTypes, queryFn: api.roomTypes }); }
export function useFloors(roomQuery: string, roomType?: string) { return useQuery({ queryKey: queryKeys.floors(roomQuery, roomType), queryFn: () => api.floors(roomQuery, roomType), enabled: Boolean(roomQuery) }); }
export function useDurations(roomQuery: string, startHour: string, roomType?: string) {
  const hour = Number(startHour);
  return useQuery({ queryKey: queryKeys.durations(roomQuery, hour, roomType), queryFn: () => api.durations(roomQuery, hour, roomType), enabled: Boolean(roomQuery) && startHour !== "" });
}

export function usePlanMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.plans });
  return {
    create: useMutation({ mutationFn: api.createPlan, onSuccess: refresh }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updatePlan>[1] }) => api.updatePlan(id, patch), onSuccess: refresh }),
    toggle: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setEnabled(id, enabled), onSuccess: refresh }),
    remove: useMutation({ mutationFn: api.deletePlan, onSuccess: refresh }),
    createGroup: useMutation({ mutationFn: ({ name, ids }: { name: string; ids: string[] }) => api.createGroup(name, ids), onSuccess: refresh }),
    updateGroup: useMutation({ mutationFn: ({ id, name, ids }: { id: string; name: string; ids: string[] }) => api.updateGroup(id, name, ids), onSuccess: refresh }),
  };
}

export function useBookingAction() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, action }: { id: string; action: string }) => api.bookingAction(id, action), onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.bookings }) });
}

export function useCheckinMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ enabled, agreed }: { enabled: boolean; agreed?: boolean }) => api.setCheckin(enabled, agreed), onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.checkin }) });
}
