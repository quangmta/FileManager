/*
 * read_map.cpp
 *
 *  Created on: Oct 26, 2026
 *      Author: a
 */
#include "read_map.h"
#include <iostream>
#include <vector>
#include <algorithm>
#include <thread>


bool MapTile::load(const std::string& dt2_path) {
	std::ifstream infile(dt2_path, std::ios::binary);
	if (!infile) {
		std::cerr << "No such file dt2\n";
		return false;
	}

	// Buffer 1 chieu, lien tuc trong bo nho (khong con vector<vector<>>)
	data_.assign((size_t)DT2_SIZE * DT2_SIZE, 0);

	// Cau truc file DT2: 3428 byte dau la Header
	infile.seekg(3428, std::ios::beg);
	char header[8];
	char check_sum[4];

	uint64_t start = clock_gettime_mon_ns();
	for (int profile = 0; profile < DT2_SIZE; profile++) {
		infile.read(header, 8); // Header cua profile (kinh do)

		uint16_t* p = data_.data() + (size_t)profile * DT2_SIZE;
		infile.read(reinterpret_cast<char*>(p), DT2_SIZE * 2);

		// File DT2 ghi diem theo thu tu Nam -> Bac trong tung profile.
		for (int i = 0; i < DT2_SIZE; i++) {
			p[i] = __builtin_bswap16(p[i]);
		}

		infile.read(check_sum, 4); // Checksum cua profile (4 byte)
	}
	uint64_t end = clock_gettime_mon_ns();
	std::cout << "Load time (read + bswap only): " << (end - start) / 1e9 << "s\n";
	return true;
}

void MapTile::transpose_blocked_mt(int block, int n_threads) {
	uint16_t* buf = data_.data();
	int n_blocks = (size_ + block - 1) / block;
    struct BlockPair { int bi, bj; };
    std::vector<BlockPair> pairs;
    pairs.reserve((size_t)n_blocks * (n_blocks + 1) / 2);
    for (int bi = 0; bi < n_blocks; bi++)
        for (int bj = bi; bj < n_blocks; bj++)
            pairs.push_back({bi, bj});

    std::atomic<size_t> next{0};
    auto worker = [&]() {
        size_t idx;
        while ((idx = next.fetch_add(1)) < pairs.size()) {
            int ib = pairs[idx].bi * block;
            int jb = pairs[idx].bj * block;
            int i_max = std::min(ib + block, (int)size_);
            int j_max = std::min(jb + block, (int)size_);
            for (int i = ib; i < i_max; i++) {
                int j_start = (jb == ib) ? i + 1 : jb;
                for (int j = j_start; j < j_max; j++) {
                    std::swap(buf[(size_t)i * size_ + j], buf[(size_t)j * size_ + i]);
                }
            }
        }
    };

    std::vector<std::thread> pool;
    pool.reserve(n_threads);
    for (int t = 0; t < n_threads; t++) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
}

void MapTile::transpose_inplace() {
    constexpr int B = 64;
    uint16_t tmp[B][B];
    uint16_t * buf = data_.data();

    for (int i = 0; i < size_; i += B) {
        const int ih = (i + B <= size_) ? B : (size_ - i);
        for (int j = 0; j < size_; j += B) {
            const int jw = (j + B <= size_) ? B : (size_ - j);

            // Copy block (i..i+ih, j..j+jw) vào tmp (đọc tuần tự theo hàng)
            for (int a = 0; a < ih; ++a) {
                memcpy(tmp[a], buf + (size_t)(i + a) * size_ + j, (size_t)jw * sizeof(uint16_t));
            }
            // Ghi transposed block vào vị trí (j..j+jw, i..i+ih) (ghi tuần tự)
            for (int b = 0; b < jw; ++b) {
                for (int a = 0; a < ih; ++a) {
                    buf[(size_t)(j + b) * size_ + (i + a)] = tmp[a][b];
                }
            }
        }
    }
}

