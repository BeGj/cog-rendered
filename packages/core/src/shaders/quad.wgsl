struct Viewport {
    center: vec2<f32>,
    scale: vec2<f32>,
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(1) @binding(0) var myTexture: texture_2d<f32>;
@group(1) @binding(1) var mySampler: sampler;

struct VertexOutput {
    @builtin(position) Position : vec4<f32>,
    @location(0) uv : vec2<f32>,
};

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );
    
    // We need tile position and size.
    // Let's pass them via push constants or a uniform buffer per tile?
    // Push constants are not fully supported in WebGPU v1 (only standard is uniform/storage buffers).
    // Let's assume we update a uniform buffer for tile metadata OR Use instance attributes if we can.
    
    // For simplicity V1: Just render a full screen quad and handle transform in CPU? No.
    // Each tile has a world position (x, y) and size (w, h).
    // Let's use a storage buffer for tile instances if we do instancing.
    // OR just pass tile transform in a uniform buffer for now (one draw per tile).
    
    // BUT! To make it fast, we want to batch.
    // For now, let's keep it simple: 1 draw per tile.
    
    var output : VertexOutput;
    output.uv = pos[VertexIndex];
    // Position logic to be added in Renderer when we decide how to pass tile rect.
    output.Position = vec4<f32>(0.0, 0.0, 0.0, 1.0); 
    return output;
}

@fragment
fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(myTexture, mySampler, uv);
}
