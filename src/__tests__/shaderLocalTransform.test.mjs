/*
 * DxfViewerPixi 셰이더가 Pixi v8 메시 로컬 변환(uTransformMatrix)을 반영하는지 검증한다.
 *
 * 배경(회귀 방지): OverlayDxf2는 DXF를 `dxfContainer.position.set(origin.x, -origin.y)`로 origin만큼
 * 옮겨 그리고, 스냅 좌표(snapContext)는 origin을 더한 월드 좌표로 만든다. Pixi v8은 개별 컨테이너/메시
 * 변환을 globalUniforms.uWorldTransformMatrix가 아니라 Pixi의 per-mesh 그룹 localUniforms.uTransformMatrix
 * (= mesh.groupTransform)로 공급한다(MeshPipe.execute). 따라서 셰이더가 clip 변환을
 * `uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix`로 쓰지 않으면 origin이 무시되어
 * DXF가 origin만큼 밀려 그려지고, 스냅은 "선이 없는 곳"에 잡힌다.
 *
 * 이 테스트는 브라우저/GPU 없이 (1) GL/WGSL 셰이더 소스가 uTransformMatrix를 선언·사용하는지,
 * (2) WGSL이 Pixi 파서에서 globalUniforms@group(0)/localUniforms@group(1)/uColorUniforms@group(2)로
 * 추출되고 autoAssignLocal/GlobalUniforms가 모두 true인지(= Pixi가 uTransformMatrix를 자동 바인딩),
 * (3) 색 그룹(uColorUniforms)이 group(2)에 바인딩되어 group99 미매칭 fallback이 생기지 않는지 확인한다.
 *
 * 실행: node src/__tests__/shaderLocalTransform.test.mjs  (의존성: 이미 설치된 pixi.js만 사용)
 */
import * as pixi from "pixi.js";
import { DxfViewerPixi } from "../DxfViewerPixi.js";

let failures = 0;
function check(name, ok) {
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) failures++;
}

const viewer = new DxfViewerPixi();

for (const kind of ["standard", "instanced"]) {
    console.log(`[${kind}]`);

    // (1) GL 소스: uTransformMatrix 선언 + mvp 반영
    const glSrc = viewer.shader[kind].gl.vertex;
    check("GL declares `uniform mat3 uTransformMatrix`", /uniform\s+mat3\s+uTransformMatrix\s*;/.test(glSrc));
    check(
        "GL mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix",
        /uProjectionMatrix\s*\*\s*uWorldTransformMatrix\s*\*\s*uTransformMatrix/.test(glSrc)
    );

    // (1) WGSL 소스: uTransformMatrix 반영
    const gpu = viewer.shader[kind].gpu;
    check("WGSL mvp uses localUniforms.uTransformMatrix", /uWorldTransformMatrix\s*\*\s*localUniforms\.uTransformMatrix/.test(gpu.vertex.source));

    // (2) WGSL 파싱: group 번호 + autoAssign 플래그
    const prog = pixi.GpuProgram.from({ vertex: gpu.vertex, fragment: gpu.fragment });
    const byName = Object.fromEntries(prog.structsAndGroups.groups.map((g) => [g.name, g]));
    check("WGSL globalUniforms @group(0)", byName.globalUniforms?.group === 0);
    check("WGSL localUniforms @group(1)", byName.localUniforms?.group === 1);
    check("WGSL uColorUniforms @group(2)", byName.uColorUniforms?.group === 2);
    check("autoAssignGlobalUniforms === true", prog.autoAssignGlobalUniforms === true);
    check("autoAssignLocalUniforms === true (Pixi binds uTransformMatrix)", prog.autoAssignLocalUniforms === true);

    // (3) 색 그룹 바인딩이 group(2)로 매핑되고 group99 fallback이 없는지 (WGSL-only shader: node엔 document 없음)
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    const shader = new pixi.Shader({
        gpuProgram: prog,
        resources: {
            uColorUniforms: new pixi.UniformGroup({
                uLineColor: { value: [1, 0, 0], type: "vec3<f32>" },
                uAlpha: { value: 1.0, type: "f32" },
            }),
        },
    });
    console.warn = origWarn;
    const bindMap = shader._uniformBindMap;
    const colorGroup = Object.keys(bindMap).find((g) => bindMap[g] && Object.values(bindMap[g]).includes("uColorUniforms"));
    check("uColorUniforms resource bound at group(2)", colorGroup === "2");
    check("no group99 unmatched-resource fallback", !bindMap[99]);
    check("no 'matches no binding' warning", !warnings.some((w) => /matches no binding/.test(w)));

    // 소비처(opacity)가 쓰는 런타임 uAlpha 변경 경로가 살아있는지
    shader.resources.uColorUniforms.uniforms.uAlpha = 0.5;
    check("runtime uAlpha mutation path intact", shader.resources.uColorUniforms.uniforms.uAlpha === 0.5);
}

if (failures > 0) {
    console.error(`\nFAILURES: ${failures}`);
    process.exit(1);
}
console.log("\nALL PASS");
