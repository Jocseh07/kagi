import { createFileRoute } from '@tanstack/react-router'
import { GenerationPage } from '@/components/generations/generation-page'

export const Route = createFileRoute('/generations/$generationId')({ component: GenerationPage })
