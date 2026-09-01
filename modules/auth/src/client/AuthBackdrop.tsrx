import { useEffect, useRef } from 'octane';

interface Dot {
	x: number;
	y: number;
	originX: number;
	originY: number;
	velocityX: number;
	velocityY: number;
	copper: boolean;
}

const SPACING = 30;
const POINTER_RADIUS = 130;

/* Decorative dot field for the sign-in story panel: a woven grid that
   drifts like water and parts under the pointer. Pure decoration, so it
   renders nothing on the server, respects reduced motion, and never
   captures pointer events. */
export function AuthBackdrop() @{
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const parent = canvas?.parentElement;
		const context = canvas?.getContext('2d');
		if (!canvas || !parent || !context) return;
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let width = 0;
		let height = 0;
		let scale = 1;
		let dots: Dot[] = [];
		let frame = 0;
		let time = 0;
		let pointerX = -10_000;
		let pointerY = -10_000;

		const build = () => {
			const rect = parent.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			scale = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			dots = [];
			let index = 0;
			for (let y = SPACING / 2; y < height; y += SPACING) {
				for (let x = SPACING / 2; x < width; x += SPACING) {
					dots.push({
						x,
						y,
						originX: x,
						originY: y,
						velocityX: 0,
						velocityY: 0,
						copper: index++ % 23 === 0,
					});
				}
			}
		};

		const draw = (animate: boolean) => {
			context.setTransform(scale, 0, 0, scale, 0, 0);
			context.clearRect(0, 0, width, height);
			for (const dot of dots) {
				if (animate) {
					const deltaX = dot.x - pointerX;
					const deltaY = dot.y - pointerY;
					const distanceSq = deltaX * deltaX + deltaY * deltaY;
					if (distanceSq < POINTER_RADIUS * POINTER_RADIUS) {
						const distance = Math.sqrt(distanceSq) || 1;
						const force = (1 - distance / POINTER_RADIUS) * 3.2;
						dot.velocityX += (deltaX / distance) * force;
						dot.velocityY += (deltaY / distance) * force;
					}
					const targetX =
						dot.originX + Math.sin(time * 0.7 + dot.originY * 0.045) * 1.6;
					const targetY =
						dot.originY + Math.cos(time * 0.6 + dot.originX * 0.05) * 1.6;
					dot.velocityX += (targetX - dot.x) * 0.02;
					dot.velocityY += (targetY - dot.y) * 0.02;
					dot.velocityX *= 0.9;
					dot.velocityY *= 0.9;
					dot.x += dot.velocityX;
					dot.y += dot.velocityY;
				}
				const drift = Math.hypot(dot.x - dot.originX, dot.y - dot.originY);
				const alpha = Math.min(0.5, 0.14 + drift * 0.02);
				context.beginPath();
				context.arc(dot.x, dot.y, dot.copper ? 1.9 : 1.4, 0, Math.PI * 2);
				context.fillStyle = dot.copper
					? `rgba(224, 138, 69, ${alpha + 0.14})`
					: `rgba(135, 148, 171, ${alpha})`;
				context.fill();
			}
		};

		const tick = () => {
			time += 1 / 60;
			draw(true);
			frame = requestAnimationFrame(tick);
		};

		const onPointerMove = (event: PointerEvent) => {
			const rect = parent.getBoundingClientRect();
			pointerX = event.clientX - rect.left;
			pointerY = event.clientY - rect.top;
		};
		const onPointerLeave = () => {
			pointerX = -10_000;
			pointerY = -10_000;
		};

		build();
		if (reducedMotion.matches) {
			draw(false);
		} else {
			parent.addEventListener('pointermove', onPointerMove);
			parent.addEventListener('pointerleave', onPointerLeave);
			frame = requestAnimationFrame(tick);
		}
		const observer = new ResizeObserver(() => {
			build();
			if (reducedMotion.matches) draw(false);
		});
		observer.observe(parent);

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			parent.removeEventListener('pointermove', onPointerMove);
			parent.removeEventListener('pointerleave', onPointerLeave);
		};
	}, []);

	<canvas class="auth-backdrop" ref={canvasRef} aria-hidden="true"></canvas>
}
