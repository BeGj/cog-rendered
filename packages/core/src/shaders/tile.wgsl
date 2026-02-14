struct Viewport {
    center: vec2<f32>,
    scale: vec2<f32>,
};

struct Settings {
    min: vec4<f32>,
    max: vec4<f32>,
};

struct TileUniforms {
    position: vec2<f32>, // World position
    size: vec2<f32>,     // World size
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<uniform> settings: Settings;

@group(1) @binding(0) var myTexture: texture_2d<f32>;
@group(1) @binding(1) var mySampler: sampler;
@group(1) @binding(2) var<uniform> tile: TileUniforms;

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
    
    var xy = pos[VertexIndex];
    
    // World Position of vertex
    var worldPos = tile.position + xy * tile.size;
    
    // Viewport Transform
    // NDC = (World - Center) * Scale
    var ndc = (worldPos - viewport.center) * viewport.scale;
    
    var output : VertexOutput;
    output.Position = vec4<f32>(ndc, 0.0, 1.0);
    output.uv = xy;
    return output;
}

@fragment
fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
    var color = textureSample(myTexture, mySampler, uv);
    
    // Check for transparency (NoData)
    if (color.a <= 0.0) {
        return vec4<f32>(0.0);
    }

    // Remap color based on provided min/max per channel
    // val = (color - min) / (max - min)
    let minVal = settings.min;
    let maxVal = settings.max;
    
    // Avoid div by zero (component-wise)
    let range = max(maxVal - minVal, vec4<f32>(0.00001));
    
    color = (color - minVal) / range;
    
    // Force alpha to 1.0 for valid pixels
    color.a = 1.0;
    
    return color;
}

@fragment
fn frag_analysis(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
    let c = textureSample(myTexture, mySampler, uv);
    // Return RGB values for analysis
    return vec4<f32>(c.r, c.g, c.b, c.a);
}
