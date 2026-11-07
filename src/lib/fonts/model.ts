export interface FontOption {
  id: string
  name: string
  stack: string
  href?: string
}

export const FONTS: readonly FontOption[] = [
  { id: 'inter', name: 'Inter', stack: "'Inter', sans-serif" },
  { id: 'geist', name: 'Geist', stack: "'Geist', sans-serif" },
  { id: 'poppins', name: 'Poppins', stack: "'Poppins', sans-serif" },
  { id: 'montserrat', name: 'Montserrat', stack: "'Montserrat', sans-serif" },
  { id: 'dm-sans', name: 'DM Sans', stack: "'DM Sans', sans-serif" },
  { id: 'plus-jakarta-sans', name: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', sans-serif" },
  { id: 'outfit', name: 'Outfit', stack: "'Outfit', sans-serif" },
  { id: 'manrope', name: 'Manrope', stack: "'Manrope', sans-serif" },
  { id: 'figtree', name: 'Figtree', stack: "'Figtree', sans-serif" },
  { id: 'work-sans', name: 'Work Sans', stack: "'Work Sans', sans-serif" },
  { id: 'space-grotesk', name: 'Space Grotesk', stack: "'Space Grotesk', sans-serif" },
  { id: 'nunito', name: 'Nunito', stack: "'Nunito', sans-serif" },
  { id: 'open-sans', name: 'Open Sans', stack: "'Open Sans', sans-serif" },
  { id: 'roboto', name: 'Roboto', stack: "'Roboto', sans-serif" },
  { id: 'ibm-plex-sans', name: 'IBM Plex Sans', stack: "'IBM Plex Sans', sans-serif" },
  { id: 'quicksand', name: 'Quicksand', stack: "'Quicksand', sans-serif" },
  { id: 'oxanium', name: 'Oxanium', stack: "'Oxanium', sans-serif" },
  { id: 'source-serif-4', name: 'Source Serif 4', stack: "'Source Serif 4', serif" },
  { id: 'lora', name: 'Lora', stack: "'Lora', serif" },
  { id: 'merriweather', name: 'Merriweather', stack: "'Merriweather', serif" },
  { id: 'playfair-display', name: 'Playfair Display', stack: "'Playfair Display', serif" },
  { id: 'libre-baskerville', name: 'Libre Baskerville', stack: "'Libre Baskerville', serif" },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', stack: "'JetBrains Mono', monospace" },
  { id: 'geist-mono', name: 'Geist Mono', stack: "'Geist Mono', monospace" },
  { id: 'fira-code', name: 'Fira Code', stack: "'Fira Code', monospace" },
  { id: 'ibm-plex-mono', name: 'IBM Plex Mono', stack: "'IBM Plex Mono', monospace" },
  { id: 'source-code-pro', name: 'Source Code Pro', stack: "'Source Code Pro', monospace" },
  { id: 'roboto-mono', name: 'Roboto Mono', stack: "'Roboto Mono', monospace" },
  { id: 'space-mono', name: 'Space Mono', stack: "'Space Mono', monospace" },
  { id: 'architects-daughter', name: 'Architects Daughter', stack: "'Architects Daughter', cursive" },
]
