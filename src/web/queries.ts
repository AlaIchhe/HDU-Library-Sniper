import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAppStore } from "./store";

const useAuthenticated = () => useAppStore((state) => state.session?.authenticated ?? false);

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
};

export function useSession() { return useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false }); }
export function usePlans() {
  const authenticated = useAuthenticated();
  return useQuery({ queryKey: queryKeys.plans, queryFn: api.plans, enabled: authenticated });
}

export function useBookings() {
  const authenticated = useAuthenticated();
  // 不后台轮询：进入「当前预约」页时才请求；操作成功、后台任务结束后由调用方主动 invalidate。
  return useQuery({ queryKey: queryKeys.bookings, queryFn: api.bookings, refetchOnMount: "always", enabled: authenticated });
}
export function useNextTarget() {
  const authenticated = useAuthenticated();
  // 侧边栏的“下一次执行”在启动、方案变更、任务结束时刷新即可，不需要 30s 轮询。
  return useQuery({ queryKey: queryKeys.nextTarget, queryFn: api.nextTarget, enabled: authenticated });
}
export function useRuntime() {
  const authenticated = useAuthenticated();
  return useQuery({ queryKey: queryKeys.runtime, queryFn: api.runtime, refetchInterval: 15_000, enabled: authenticated });
}
export function useCheckin() {
  const authenticated = useAuthenticated();
  return useQuery({ queryKey: queryKeys.checkin, queryFn: api.checkinStatus, enabled: authenticated });
}
export function useRoomTypes() {
  const authenticated = useAuthenticated();
  return useQuery({ queryKey: queryKeys.roomTypes, queryFn: api.roomTypes, enabled: authenticated });
}
export function useFloors(roomQuery: string, roomType?: string) {
  const authenticated = useAuthenticated();
  return useQuery({ queryKey: queryKeys.floors(roomQuery, roomType), queryFn: () => api.floors(roomQuery, roomType), enabled: authenticated && Boolean(roomQuery) });
}
export function useDurations(roomQuery: string, startHour: string, roomType?: string) {
  const hour = Number(startHour);
  const authenticated = useAuthenticated();
  return useQuery({ queryKey: queryKeys.durations(roomQuery, hour, roomType), queryFn: () => api.durations(roomQuery, hour, roomType), enabled: authenticated && Boolean(roomQuery) && startHour !== "" });
}

export function usePlanMutations() {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.plans });
    void client.invalidateQueries({ queryKey: queryKeys.nextTarget });
  };
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
  return useMutation({
    mutationFn: ({ enabled, agreed }: { enabled: boolean; agreed?: boolean }) => api.setCheckin(enabled, agreed),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.checkin });
      void client.invalidateQueries({ queryKey: queryKeys.nextTarget });
    },
  });
}
