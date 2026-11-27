import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./api"
import type { BookingAction, BookingPlan } from "../../shared/types"

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

function useAuthenticated() {
  return Boolean(useSession().data?.authenticated)
}

export function usePlans() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.plans, queryFn: api.plans, enabled: authenticated })
}

export function useBookings() {
  const authenticated = useAuthenticated()
  return useQuery({
    queryKey: queryKeys.bookings,
    queryFn: api.bookings,
    refetchOnMount: "always",
    enabled: authenticated,
  })
}

export function useNextTarget() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.nextTarget, queryFn: api.nextTarget, enabled: authenticated })
}

export function useRuntime() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.runtime, queryFn: api.runtime, enabled: authenticated })
}

export function useCheckin() {
  const authenticated = useAuthenticated()
  return useQuery({ queryKey: queryKeys.checkin, queryFn: api.checkinStatus, enabled: authenticated })
}

const PERSISTED_CATALOG_QUERY = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const

export function useRoomTypes() {
  const authenticated = useAuthenticated()
  return useQuery({
    queryKey: queryKeys.roomTypes,
    queryFn: () => api.roomTypes(),
    enabled: authenticated,
    ...PERSISTED_CATALOG_QUERY,
  })
}

export function useFloors(roomQuery: string, roomType?: string) {
  const authenticated = useAuthenticated()
  return useQuery({
    queryKey: queryKeys.floors(roomQuery, roomType),
    queryFn: () => api.floors(roomQuery, roomType),
    enabled: authenticated && Boolean(roomQuery),
    ...PERSISTED_CATALOG_QUERY,
  })
}

export function useDurations(roomQuery: string, startHour: string, roomType?: string) {
  const hour = Number(startHour)
  const authenticated = useAuthenticated()
  return useQuery({
    queryKey: queryKeys.durations(roomQuery, hour, roomType),
    queryFn: () => api.durations(roomQuery, hour, roomType),
    enabled: authenticated && Boolean(roomQuery) && startHour !== "",
    ...PERSISTED_CATALOG_QUERY,
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
    toggle: useMutation({
      mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setEnabled(id, enabled),
      onMutate: async ({ id, enabled }) => {
        await client.cancelQueries({ queryKey: queryKeys.plans })
        const previous = client.getQueryData<{ plans: BookingPlan[] }>(queryKeys.plans)
        if (previous) {
          client.setQueryData<{ plans: BookingPlan[] }>(queryKeys.plans, {
            plans: previous.plans.map((item) => {
              if (item.id === id) return { ...item, enabled }
              return enabled ? { ...item, enabled: false } : item
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
  }
}

export function useBookingAction() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: BookingAction }) => api.bookingAction(id, action),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.bookings }),
  })
}

export function useCheckinMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ enabled, agreed }: { enabled: boolean; agreed?: boolean }) =>
      api.setCheckin(enabled, agreed),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.checkin, data)
      void client.invalidateQueries({ queryKey: queryKeys.checkin })
      void client.invalidateQueries({ queryKey: queryKeys.nextTarget })
    },
  })
}
