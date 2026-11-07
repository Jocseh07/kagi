import { createFileRoute } from '@tanstack/react-router'
import { GenerationsPage } from '@/components/generations/generations-page'

export const Route = createFileRoute('/generations/')({ component: GenerationsPage })
