import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["icon-192.png", "icon-512.png"],
			manifest: {
				name: "Arrosage Balcon",
				short_name: "Arrosage",
				description: "Pilotage du systeme d'arrosage automatique",
				theme_color: "#0f172a",
				background_color: "#0f172a",
				display: "standalone",
				start_url: "/",
				icons: [
					{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
					{
						src: "/icon-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "any maskable",
					},
				],
			},
			workbox: {
				// L'API doit toujours etre fraiche : network-first.
				runtimeCaching: [
					{
						urlPattern: /\/api\/.*/,
						handler: "NetworkFirst",
						options: { cacheName: "api", networkTimeoutSeconds: 5 },
					},
				],
			},
		}),
	],
	build: {
		outDir: "../public",
		emptyOutDir: true,
	},
	server: {
		proxy: { "/api": "http://localhost:3000" },
	},
});
