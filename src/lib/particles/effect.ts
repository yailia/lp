import * as THREE from 'three';

export function initParticles(container: HTMLElement) {
  const isMobile = /Mobi|Android/i.test(navigator.userAgent) || window.innerWidth < 768;
  const W = isMobile ? 64 : 128;
  const H = W;
  const COUNT = W * H;

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x050509, 1);
  container.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, {
    display: 'block',
    width: '100%',
    height: '100%',
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(80, 1, 0.001, 1000);
  camera.position.set(0, 0, 80);
  camera.lookAt(0, 0, 0);

  const vLight = new THREE.Mesh(
    new THREE.IcosahedronGeometry(8, 3),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  scene.add(vLight);

  // --- GPGPU: origin texture + ping-pong RTs ---
  const originData = new Float32Array(COUNT * 4);
  const spread = 0.35;
  for (let i = 0; i < COUNT; i++) {
    originData[i * 4 + 0] = (Math.random() - 0.5) * spread * 2;
    originData[i * 4 + 1] = (Math.random() - 0.5) * spread * 2;
    originData[i * 4 + 2] = (Math.random() - 0.5) * spread * 2;
    originData[i * 4 + 3] = Math.random();
  }
  const originTex = new THREE.DataTexture(
    originData,
    W,
    H,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  originTex.needsUpdate = true;
  originTex.minFilter = THREE.NearestFilter;
  originTex.magFilter = THREE.NearestFilter;

  const rtOpts: THREE.RenderTargetOptions = {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
    depthBuffer: false,
    stencilBuffer: false,
  };
  let rtA = new THREE.WebGLRenderTarget(W, H, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(W, H, rtOpts);

  const quadVert = `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  const simFrag = `
    precision highp float;
    uniform sampler2D tPrev;
    uniform sampler2D tOrigin;
    uniform float timer;
    uniform float dt;
    varying vec2 vUv;

    vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
    vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
    vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
      vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g;
      vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
      float n_=.142857142857; vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
      vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
      vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
      return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    vec3 flow(vec3 p, float t){
      float e = 0.15;
      float n1 = snoise(p * 1.2 + vec3(0.0, t * 0.3, 0.0));
      float n2 = snoise(p * 1.2 + vec3(17.0, t * 0.3 + 5.0, 31.0));
      float n3 = snoise(p * 1.2 + vec3(41.0, t * 0.3 + 9.0, 73.0));
      vec3 swirl = vec3(-p.z, 0.2, p.x) * 0.6;
      return swirl + vec3(n1, n2, n3) * 0.8;
    }

    void main(){
      vec4 prev = texture2D(tPrev, vUv);
      vec4 orig = texture2D(tOrigin, vUv);
      float life = prev.a - dt * 0.6;
      vec3 pos = prev.xyz + flow(prev.xyz * 1.5, timer) * dt * 0.35;
      if(life <= 0.0){
        pos = orig.xyz;
        life = 1.0;
      }
      gl_FragColor = vec4(pos, life);
    }
  `;

  const simMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: simFrag,
    uniforms: {
      tPrev: { value: null },
      tOrigin: { value: originTex },
      timer: { value: 0 },
      dt: { value: 0.016 },
    },
  });

  const simScene = new THREE.Scene();
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat);
  simScene.add(simQuad);

  // seed both RTs with origin data
  const initMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: `
      precision highp float;
      uniform sampler2D t;
      varying vec2 vUv;
      void main(){ gl_FragColor = texture2D(t, vUv); }
    `,
    uniforms: { t: { value: originTex } },
  });
  simQuad.material = initMat;
  renderer.setRenderTarget(rtA);
  renderer.render(simScene, simCamera);
  renderer.setRenderTarget(rtB);
  renderer.render(simScene, simCamera);
  renderer.setRenderTarget(null);
  simQuad.material = simMat;

  // --- Instanced stroke geometry ---
  const strokeGeo = new THREE.BoxGeometry(1, 1, 1);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = strokeGeo.index;
  instGeo.attributes.position = strokeGeo.attributes.position;
  instGeo.attributes.normal = strokeGeo.attributes.normal;
  instGeo.attributes.uv = strokeGeo.attributes.uv;
  const aPUV = new Float32Array(COUNT * 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      aPUV[i * 2 + 0] = (x + 0.5) / W;
      aPUV[i * 2 + 1] = (y + 0.5) / H;
    }
  }
  instGeo.setAttribute('aPUV', new THREE.InstancedBufferAttribute(aPUV, 2));
  instGeo.instanceCount = COUNT;

  const particleVert = `
    precision highp float;
    uniform sampler2D map;
    uniform sampler2D oldmap;
    attribute vec2 aPUV;
    varying float vLife;
    varying vec3 vNormalW;

    mat3 rotationMatrix(vec3 axis, float angle){
      axis = normalize(axis);
      float s = sin(angle);
      float c = cos(angle);
      float oc = 1.0 - c;
      return mat3(
        oc*axis.x*axis.x + c,        oc*axis.x*axis.y - axis.z*s, oc*axis.z*axis.x + axis.y*s,
        oc*axis.x*axis.y + axis.z*s, oc*axis.y*axis.y + c,        oc*axis.y*axis.z - axis.x*s,
        oc*axis.z*axis.x - axis.y*s, oc*axis.y*axis.z + axis.x*s, oc*axis.z*axis.z + c
      );
    }

    void main(){
      vec4 buffer = texture2D(map, aPUV);
      vec4 oldbuffer = texture2D(oldmap, aPUV);
      vec3 d = buffer.xyz - oldbuffer.xyz;
      float dl = length(d);
      vec3 dir = dl > 0.0001 ? d / dl : vec3(0.0, 1.0, 0.0);

      float life = buffer.a;
      vLife = life;

      float scaleX = 3.0;
      float scaleY = 0.3;
      float scaleZ = 1.0;
      float truelife = sin(life / 0.32);

      mat3 R = rotationMatrix(dir, 1.0 - life);
      vec3 local = vec3(position.x*scaleX, position.y*scaleY, position.z*scaleZ) * truelife;
      vec3 world = buffer.xyz * 100.0 + R * local;
      vNormalW = R * normal;

      gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    }
  `;

  const particleFrag = `
    precision highp float;
    uniform vec3 firstColor;
    uniform vec3 secondColor;
    varying float vLife;
    varying vec3 vNormalW;
    void main(){
      vec3 L = normalize(vec3(0.3, 0.6, 0.7));
      float ndl = max(dot(normalize(vNormalW), L), 0.0);
      vec3 base = mix(secondColor, firstColor, vLife);
      vec3 col = base + vec3(0.08) * ndl;
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const particleUniforms = {
    map: { value: null as THREE.Texture | null },
    oldmap: { value: null as THREE.Texture | null },
    firstColor: { value: new THREE.Color(0x406B00) },
    secondColor: { value: new THREE.Color(0x7DD100) },
  };

  const particleMat = new THREE.ShaderMaterial({
    vertexShader: particleVert,
    fragmentShader: particleFrag,
    uniforms: particleUniforms,
  });

  const cloneMat = new THREE.ShaderMaterial({
    vertexShader: particleVert,
    fragmentShader: particleFrag,
    uniforms: {
      map: particleUniforms.map,
      oldmap: particleUniforms.oldmap,
      firstColor: { value: new THREE.Color(0x000000) },
      secondColor: { value: new THREE.Color(0x000000) },
    },
  });

  const mesh = new THREE.Mesh(instGeo, particleMat);
  const meshClone = new THREE.Mesh(instGeo, cloneMat);
  mesh.frustumCulled = false;
  meshClone.frustumCulled = false;
  scene.add(mesh);
  scene.add(meshClone);

  // --- Post FX ---
  const rtMain = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  const rtGod = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  const rtRays = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });

  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  fsScene.add(fsQuad);

  const godrayMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform vec2 lightPos;
      uniform float exposure;
      uniform float decay;
      uniform float density;
      uniform float weight;
      varying vec2 vUv;
      const int SAMPLES = 80;
      void main(){
        vec2 uv = vUv;
        vec2 delta = (uv - lightPos) * (1.0 / float(SAMPLES)) * density;
        vec4 color = texture2D(tDiffuse, uv);
        float illum = 1.0;
        for(int i = 0; i < SAMPLES; i++){
          uv -= delta;
          vec4 s = texture2D(tDiffuse, uv) * illum * weight;
          color += s;
          illum *= decay;
        }
        gl_FragColor = color * exposure;
      }
    `,
    uniforms: {
      tDiffuse: { value: null },
      lightPos: { value: new THREE.Vector2(0.5, 0.5) },
      exposure: { value: 0.35 },
      decay: { value: 0.96 },
      density: { value: 0.85 },
      weight: { value: 0.45 },
    },
  });

  const blendMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tMain;
      uniform sampler2D tRays;
      varying vec2 vUv;
      void main(){
        vec4 a = texture2D(tMain, vUv);
        vec4 b = texture2D(tRays, vUv);
        gl_FragColor = vec4(a.rgb + b.rgb, 1.0);
      }
    `,
    uniforms: {
      tMain: { value: null },
      tRays: { value: null },
    },
  });

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const dpr = renderer.getPixelRatio();
    rtMain.setSize(w * dpr, h * dpr);
    rtGod.setSize(w * dpr, h * dpr);
    rtRays.setSize(w * dpr, h * dpr);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const clock = new THREE.Clock();
  let inTex = rtA;
  let outTex = rtB;
  const sunPos = new THREE.Vector3(0, 0, 0);
  const sunTarget = new THREE.Vector3(0, 0, 0);
  const sunScreen = new THREE.Vector3();
  const mouseNDC = new THREE.Vector2(0, 0);
  const mouseTarget = new THREE.Vector2(0, 0);
  let rafId = 0;

  const onMove = (e: PointerEvent) => {
    const r = container.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    mouseTarget.set(x * 2 - 1, -(y * 2 - 1));
  };
  const onLeave = () => mouseTarget.set(0, 0);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.033);
    simMat.uniforms.timer.value += dt;
    simMat.uniforms.dt.value = dt;

    simMat.uniforms.tPrev.value = inTex.texture;
    renderer.setRenderTarget(outTex);
    renderer.render(simScene, simCamera);
    renderer.setRenderTarget(null);

    particleUniforms.map.value = outTex.texture;
    particleUniforms.oldmap.value = inTex.texture;

    const tmp = inTex;
    inTex = outTex;
    outTex = tmp;

    mouseNDC.x += (mouseTarget.x - mouseNDC.x) * 0.08;
    mouseNDC.y += (mouseTarget.y - mouseNDC.y) * 0.08;

    const t = simMat.uniforms.timer.value;
    const baseX = Math.sin(t * 0.08) * 85;
    const baseZ = Math.cos(t * 0.08) * 85;
    const baseY = Math.sin(t * 0.05) * 8;
    camera.position.set(
      baseX + mouseNDC.x * 14,
      baseY + mouseNDC.y * 10,
      baseZ,
    );

    sunTarget.set(mouseNDC.x * 22, mouseNDC.y * 14, 0);
    sunPos.lerp(sunTarget, 0.1);
    vLight.position.copy(sunPos);
    camera.lookAt(sunPos.x * 0.3, sunPos.y * 0.3, 0);

    // 1) godray source: clone (black) + sun (white) on black
    mesh.visible = false;
    meshClone.visible = true;
    vLight.visible = true;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(rtGod);
    renderer.clear();
    renderer.render(scene, camera);

    // 2) radial blur → rays
    sunScreen.copy(sunPos).project(camera);
    godrayMat.uniforms.lightPos.value.set(
      (sunScreen.x + 1) * 0.5,
      (sunScreen.y + 1) * 0.5,
    );
    godrayMat.uniforms.tDiffuse.value = rtGod.texture;
    fsQuad.material = godrayMat;
    renderer.setRenderTarget(rtRays);
    renderer.render(fsScene, fsCam);

    // 3) main scene: particles + sun on dark bg
    mesh.visible = true;
    meshClone.visible = false;
    vLight.visible = true;
    renderer.setClearColor(0x050509, 1);
    renderer.setRenderTarget(rtMain);
    renderer.clear();
    renderer.render(scene, camera);

    // 4) additive blend to screen
    blendMat.uniforms.tMain.value = rtMain.texture;
    blendMat.uniforms.tRays.value = rtRays.texture;
    fsQuad.material = blendMat;
    renderer.setRenderTarget(null);
    renderer.render(fsScene, fsCam);

    rafId = requestAnimationFrame(frame);
  }
  frame();

  return () => {
    cancelAnimationFrame(rafId);
    ro.disconnect();
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerleave', onLeave);
    renderer.dispose();
    rtA.dispose();
    rtB.dispose();
    rtMain.dispose();
    rtGod.dispose();
    rtRays.dispose();
    instGeo.dispose();
    strokeGeo.dispose();
    particleMat.dispose();
    cloneMat.dispose();
    simMat.dispose();
    initMat.dispose();
    godrayMat.dispose();
    blendMat.dispose();
    container.removeChild(renderer.domElement);
  };
}
