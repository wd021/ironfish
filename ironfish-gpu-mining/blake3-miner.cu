#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cuda_profiler_api.h>
// #include <unistd.h>
#include <string.h>
#include <chrono>
#include <thread>
#include <ctime>
#include <assert.h>
//#include <windows.h>
// #include <cmocka.h>
#include "./blake3/blake3.cu"

 //!!nvcc -c  test.cu --compiler-options -fPIC

#if !defined(ssize_t)
typedef long ssize_t;
#endif

#define bzero(b, len) (memset((b), '\0', (len)), (void) 0)

typedef struct blob_t {
    uint8_t *blob;
    ssize_t len;
} blob_t;

void free_blob(blob_t *blob)
{
    free(blob->blob);
}

char *bytes_to_hex(uint8_t *bytes, ssize_t len)
{
    ssize_t hex_len = 2 * len + 1;
    char *hex_string = (char *)malloc(hex_len);
    memset(hex_string, 0, hex_len);

    uint8_t *byte_cursor = bytes;
    char *hex_cursor = hex_string;
    ssize_t count = 0;
    while (count < len) {
        sprintf(hex_cursor, "%02x", *byte_cursor);
        byte_cursor++;
        count++;
        hex_cursor += 2;
    }

    return hex_string;
}

char hex_to_byte(char hex)
{
    if (hex >= '0' && hex <= '9') {
        return hex - '0';
    } else if (hex >= 'a' && hex <= 'f') {
        return hex - 'a' + 10;
    } else {
        exit(1);
    }
}

void hex_to_bytes(const char *hex_data, blob_t *buf)
{
    // printf("789987");
    size_t hex_len = strlen(hex_data);
    assert(hex_len % 2 == 0);

    buf->len = hex_len / 2;
    buf->blob = (uint8_t *)malloc(buf->len);
    memset(buf->blob, 0, buf->len);

    for (size_t pos = 0; pos < hex_len; pos += 2) {
        char left = hex_to_byte(hex_data[pos]);
        char right = hex_to_byte(hex_data[pos + 1]);
        buf->blob[pos / 2] = (left << 4) + right;
    }
}

char* mine(const char *header_string, const char *target_string){
    cudaProfilerStart();
    blob_t blob;
    hex_to_bytes(
            header_string,
            &blob);

    blob_t target;
    hex_to_bytes(target_string, &target);

    inline_blake::blake3_hasher *hasher;
    inline_blake::blake3_hasher *device_hasher1;
    TRY(cudaMallocHost(&hasher, sizeof(inline_blake::blake3_hasher)));
    TRY(cudaMalloc(&device_hasher1, sizeof(inline_blake::blake3_hasher)));

    bzero(hasher->buf, BLAKE3_BUF_CAP);
    cudaMemcpy(hasher->buf, blob.blob, sizeof(BLAKE3_BUF_CAP), cudaMemcpyHostToDevice);
    cudaMemcpy(hasher->target, target.blob, sizeof(32), cudaMemcpyHostToDevice);
    memcpy(hasher->target, target.blob, target.len);
    memcpy(hasher->buf, blob.blob, blob.len);
    hasher->from_group = 2;
    hasher->to_group = 2;

    cudaStream_t stream;
    TRY(cudaStreamCreate(&stream));
    TRY(cudaMemcpyAsync(device_hasher1, hasher, sizeof(inline_blake::blake3_hasher), cudaMemcpyHostToDevice, stream));
    inline_blake::blake3_hasher_mine<<<92, 256, 0, stream>>>(device_hasher1);
    TRY(cudaStreamSynchronize(stream));
    cudaDeviceSynchronize();

    TRY(cudaMemcpy(hasher, device_hasher1, sizeof(inline_blake::blake3_hasher), cudaMemcpyDeviceToHost));
    char *hash_string1 = bytes_to_hex(hasher->hash, 32);
    char *buf_string1 = bytes_to_hex(hasher->buf, 208);
    printf("good: %d\n", hasher->found_good_hash);
    printf("nonce: %d\n", hasher->buf[0]);
    printf("buf: %d\n", hasher->buf);
    printf("count: %d\n", hasher->hash_count);
    printf("%s\n", hash_string1); 
    printf("%s\n", buf_string1);
    cudaProfilerStop();
    return buf_string1;
}


// int main(void) {
//     cudaProfilerStart();
//     blob_t blob;
//     hex_to_bytes(
//             "0000000000000000cf0e020000000000000000000002aaced825176dd9db0701c995760a03a1f42c69b63b4b7d4090b0ff7f32477b07a0cc3c89d6f6335433def2d95ff91be838ae47212ba43794901bb0ce220200000000f6ee7f75663920ae6d8617379629d5130323e6e20c5e19cb5606c71bb97ed7e668d5130100000000000000000007b87e00ba71e3b4a9a27d79dad30a55297da63550092644b289502c8efe8f82010000000000007736f4a168656e7461693800000000000000000000000000000000000000000000000000",
//             &blob);

//     blob_t target;
//     hex_to_bytes("0000000fffffffffffffffffffffffff", &target);

//     inline_blake::blake3_hasher *hasher;
//     inline_blake::blake3_hasher *device_hasher1;
//     TRY(cudaMallocHost(&hasher, sizeof(inline_blake::blake3_hasher)));
//     TRY(cudaMalloc(&device_hasher1, sizeof(inline_blake::blake3_hasher)));

//     bzero(hasher->buf, BLAKE3_BUF_CAP);
//     cudaMemcpy(hasher->buf, blob.blob, sizeof(BLAKE3_BUF_CAP), cudaMemcpyHostToDevice);
//     cudaMemcpy(hasher->target, target.blob, sizeof(32), cudaMemcpyHostToDevice);
//     memcpy(hasher->target, target.blob, target.len);
//     memcpy(hasher->buf, blob.blob, blob.len);
//     hasher->from_group = 2;
//     hasher->to_group = 2;

//     cudaStream_t stream;
//     TRY(cudaStreamCreate(&stream));
//     TRY(cudaMemcpyAsync(device_hasher1, hasher, sizeof(inline_blake::blake3_hasher), cudaMemcpyHostToDevice, stream));
//     inline_blake::blake3_hasher_mine<<<92, 256, 0, stream>>>(device_hasher1);
//     TRY(cudaStreamSynchronize(stream));
//     cudaDeviceSynchronize();

//     TRY(cudaMemcpy(hasher, device_hasher1, sizeof(inline_blake::blake3_hasher), cudaMemcpyDeviceToHost));
//     char *hash_string1 = bytes_to_hex(hasher->hash, 32);
//     char *buf_string1 = bytes_to_hex(hasher->buf, 208);
//     printf("good: %d\n", hasher->found_good_hash);
//     printf("nonce: %d\n", hasher->buf[0]);
//     printf("buf: %d\n", hasher->buf);
//     printf("count: %d\n", hasher->hash_count);
//     printf("%s\n", hash_string1); 
//     printf("%s\n", buf_string1);
//     cudaProfilerStop();
// }