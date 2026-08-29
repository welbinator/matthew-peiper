import cloudflare from "@astrojs/cloudflare";
import { defineConfig, fontProviders } from "astro/config";

// Production (Cloudflare workers.dev / root domain): leave PAGES_BASE unset → base "/"
// Staging (GitHub Pages project site): PAGES_BASE=/matthew-peiper/
// All internal links/assets use withBase() so both mounts work from one codebase.
export default defineConfig({
	site: "https://matthewpeiper.com",
	base: process.env.PAGES_BASE || "/",
	// Keep CSS external so any relative url() paths resolve from /_astro/, not the page URL.
	build: { inlineStylesheets: "never" },
	output: "static",
	adapter: cloudflare({
		platformProxy: { enabled: true },
		imageService: "compile",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Montserrat",
			cssVariable: "--font-body",
			weights: [300, 400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Cormorant Garamond",
			cssVariable: "--font-heading",
			weights: [400, 500, 600, 700],
			styles: ["normal", "italic"],
			fallbacks: ["serif"],
		},
	],
	devToolbar: { enabled: false },
});
