/*
 * read_map.h
 *
 *  Created on: Oct 26, 2026
 *      Author: a
 */

#ifndef SRC_READ_MAP_READ_MAP_H_
#define SRC_READ_MAP_READ_MAP_H_


#include <cstdint>
#include <cstring>
#include <fstream>
#include <atomic>

constexpr int DT2_SIZE = 3601;

class MapTile {
public:
	MapTile(uint16_t size = DT2_SIZE);
	virtual ~MapTile() = default;
    bool load(const std::string& dt2_path);

    // Truy van do cao tai (lat_idx, long_idx) theo dung quy uoc "row=lat,
    // col=long" voi ma tran chua transpose
    uint16_t elevation(int lat_idx, int long_idx) const {
        return data_[(size_t)long_idx * size_ + lat_idx];
    }

    const uint16_t* raw_data() const { return data_.data(); }
    size_t size() const { return size_; }

    // transpose_inplace mat 0.5s
    void transpose_inplace();

    // Neu muon toi uu thoi gian thi dung ham transpose_blocked_mt,
    // thoi gian transpose neu dung full 4 thread cho 4 cpu la 0.175s
    void transpose_blocked_mt(int block = 64, int n_threads = 4);

private:
    std::vector<uint16_t> data_;
    int size_;
};

#endif /* SRC_READ_MAP_READ_MAP_H_ */
