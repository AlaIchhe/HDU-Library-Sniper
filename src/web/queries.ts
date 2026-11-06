import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { useAppStore } from "./store"
import type { PlanListItem } from "../shared/types"

const useAuthenticated = () => useAppStore((state) => state.session?.authenticated ?? false)

export const queryKeys = {
  session: ["session"] as const,
  plans: ["plans"] as const,
  bookings: ["bookings"] as const,
  checkin: ["checkin"] as const,
  nextTarget: ["next-target"] as const,
  runtime: ["runtime"] as const,
  roomTypes: ["room-types"] as const,
  floors: (roomQuery: string, roomType?: string) => ["floors", roomQuery, roomType || ""] as const,
  durations: (roomQuery: string, startHour: number, roomType?: string) =>
    ["durations", roomQuery, roomType || "", startHour] as const,
}

export function useSession() {
  return useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false })
}
export function usePlans() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.plans, queryFn: api.plans, enabled: authenticated })
}

export function useBookings() {
  const authenticated = useAuthenticated()
  // 不后台轮询：进入「当前预约」页时才请求；操作成功、后台任务结束后由调用方主动 invalidate。
  return useQuery({
    queryKey: queryKeys.bookings,
    queryFn: api.bookings,
    refetchOnMount: "always",
    enabled: authenticated,
  })
}
export function useNextTarget() {
  const authenticated = useAuthenticated()
  // 侧边栏的“下一次执行”在启动、方案变更、任务结束时刷新即可，不需要 30s 轮询。
  return useQuery({ queryKey: queryKeys.nextTarget, queryFn: api.nextTarget, enabled: authenticated })
}
export function useRuntime() {
  const authenticated = useAuthenticated()
  // 不轮询：进入/聚焦应用、或发生操作时刷新即可。
  return useQuery({ queryKey: queryKeys.runtime, queryFn: api.runtime, enabled: authenticated })
}
export function useCheckin() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.checkin, queryFn: api.checkinStatus, enabled: authenticated })
}
export function useRoomTypes() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.roomTypes, queryFn: api.roomTypes, enabled: authenticated })
}
export function useFloors(roomQuery: string, roomType?: string) {
  const authenticated = useAuthenticated()
  return useQuery({
    queryKey: queryKeys.floors(roomQuery, roomType),
    queryFn: () => api.floors(roomQuery, roomType),
    enabled: authenticated && Boolean(roomQuery),
  })
}
export function useDurations(roomQuery: string, startHour: string, roomType?: string) {
  const hour = Number(startHour)
  const authenticated = useAuthenticated()
  return useQuery({
    queryKey: queryKeys.durations(roomQuery, hour, roomType),
    queryFn: () => api.durations(roomQuery, hour, roomType),
    enabled: authenticated && Boolean(roomQuery) && startHour !== "",
  })
}

export function usePlanMutations() {
  const client = useQueryClient()
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.plans })
    void client.invalidateQueries({ queryKey: queryKeys.nextTarget })
  }
  return {
    create: useMutation({ mutationFn: api.createPlan, onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updatePlan>[1] }) =>
        api.updatePlan(id, patch),
      onSuccess: refresh,
    }),
    // 返回值里的 disabledPlanIds 是「启用新方案时被自动停用的方案」，
    // 调用方靠它做撤销，所以这里必须把后端响应透出去。
    // 同时先乐观更新开关：本地后端一个来回虽然快，但网络抖动时开关不动，
    // 用户会以为没点上而重复点击；失败时再回滚。
    toggle: useMutation({
      mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setEnabled(id, enabled),
      onMutate: async ({ id, enabled }) => {
        await client.cancelQueries({ queryKey: queryKeys.plans })
        const previous = client.getQueryData<{ plans: PlanListItem[] }>(queryKeys.plans)
        if (previous) {
          client.setQueryData<{ plans: PlanListItem[] }>(queryKeys.plans, {
            plans: previous.plans.map((item) => {
              if (item.id === id) return { ...item, enabled } as PlanListItem
              return enabled ? ({ ...item, enabled: false } as PlanListItem) : item
            }),
          })
        }
        return { previous }
      },
      onError: (_error, _variables, context) => {
        if (context?.previous) client.setQueryData(queryKeys.plans, context.previous)
      },
      onSettled: refresh,
    }),
    remove: useMutation({ mutationFn: api.deletePlan, onSuccess: refresh }),
    createGroup: useMutation({
      mutationFn: ({ name, ids }: { name: string; ids: string[] }) => api.createGroup(name, ids),
      onSuccess: refresh,
    }),
    updateGroup: useMutation({
      mutationFn: ({ id, name, ids }: { id: string; name: string; ids: string[] }) =>
        api.updateGroup(id, name, ids),
      onSuccess: refresh,
    }),
  }
}

export function useBookingAction() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.bookingAction(id, action),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.bookings }),
  })
}

export function useCheckinMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ enabled, agreed }: { enabled: boolean; agreed?: boolean }) =>
      api.setCheckin(enabled, agreed),
    // 接口返回的就是最新状态：先写进缓存，保证按钮立刻更新；
    // 再 invalidate 兜底（刷新失败时 UI 也不会停留在旧状态）。
    onSuccess: (data) => {
      client.setQueryData(queryKeys.checkin, data)
      void client.invalidateQueries({ queryKey: queryKeys.checkin })
      void client.invalidateQueries({ queryKey: queryKeys.nextTarget })
    },
  })
}
